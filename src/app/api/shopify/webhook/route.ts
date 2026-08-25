// ============================================================
// POST /api/shopify/webhook — Shopify order events → WhatsApp
// template notifications.
//
// In-repo route (not a separate service) per the tradeoffs discussed:
// calls `resolveConversationByPhone` + `sendMessageToConversation`
// directly with the service-role client, skipping the API-key/HTTP
// hop the public `/api/v1/messages` endpoint exists for external
// callers to use. Mirrors the existing inbound Meta webhook
// (`/api/whatsapp/webhook`) and the automations engine, both of which
// call internal lib functions directly rather than calling our own
// public API.
//
// Flow per delivery:
//   1. Read the raw body (needed byte-for-byte for HMAC verification).
//   2. Look up the shop by `X-Shopify-Shop-Domain` → account_id +
//      webhook_secret.
//   3. Verify `X-Shopify-Hmac-Sha256` against that shop's secret.
//   4. Dedupe on `X-Shopify-Webhook-Id` (Shopify redelivers on
//      timeout/non-2xx, and can redeliver on ambiguous network
//      failures even after a successful 200).
//   5. Ack 200 immediately; do the actual mapping + send in `after()`
//      so Shopify's delivery timeout never turns into a retry storm.
//   6. Record the outcome back onto the dedupe row (`sent` / `scheduled`
//      / `skipped` / `failed` + a reason) — that row IS the "why didn't
//      this message go out" log; query it instead of Vercel logs.
//
// Topics handled directly (send now):
//   orders/create        → order_placed_prepaid / order_placed_cod
//   orders/cancelled     → order_cancelled
//   fulfillments/create  → shipped
//   fulfillments/update  → order_delivered (shipment_status=delivered);
//                           out_for_delivery_prepaid / out_for_delivery_cod
//                           (shipment_status=out_for_delivery), via
//                           shopify_order_cache — see below.
//                           missing/unset shipment_status and any other
//                           unmapped value are SKIPPED, each with its
//                           own distinct reason (see handleFulfillmentUpdate).
//   refunds/create        → refund_prepaid, via shopify_order_cache —
//                            see below.
//
// Topics handled via the deferred-send queue (`shopify_scheduled_notifications`,
// drained by `/api/cron/shopify-notifications`) because they aren't a
// single-event trigger:
//   checkouts/create → schedules abandoned_cart, cancelled if the same
//                       checkout_token shows up on a later orders/create.
//   (orders/create, when COD) → schedules cod_followup, cancelled if
//                       the same order_id gets a fulfillments/create.
//
// shopify_order_cache (migration 041): neither the Fulfillment payload
// (fulfillments/update) nor the Refund payload (refunds/create) carries
// enough to build their templates on their own — confirmed against
// Shopify's Fulfillment REST resource docs that it has no
// financial_status/gateway/payment_gateway_names at all (it's a
// shipping resource, not a payment one), and the Refund payload has no
// customer/shipping_address/phone whatsoever. Rather than an external
// Admin API lookup per event, `handleOrderCreate` snapshots what these
// two handlers need into `shopify_order_cache` once, at order creation.
// A miss (order predates the cache, or its orders/create webhook
// failed/was missed) means both handlers still skip-and-log rather
// than guessing prepaid/cod or fabricating contact info — see
// `getOrderCache` and its call sites.
//
// Known gaps, deliberately left unresolved (confirmed in chat):
//   - refund_prepaid is the only refund template in this catalog —
//     no refund_cod counterpart exists for a COD order's refund, so
//     handleRefundCreate skips (cached.is_prepaid === false) rather
//     than sending "refunded to your original payment method" copy
//     that doesn't describe a COD order. Revisit if COD refunds turn
//     out to be common enough to justify a new template.
//   - Template body variable order ({{1}}, {{2}}, …) below is a
//     best-effort guess per template — confirm against your actual
//     approved templates before relying on this in production.
// ============================================================

import { NextResponse, after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyShopifyWebhookSignature } from '@/lib/shopify/webhook-signature'
import { normalizeShopifyPhone } from '@/lib/shopify/phone-normalize'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// Ack Shopify fast; the real work runs in `after()`, which shares this
// same execution's time budget on Vercel. 30s is generous headroom
// for one Meta send + a couple of Supabase round-trips.
export const maxDuration = 30

const LANGUAGE = 'en' // TODO: confirm — matches the `language` your templates were approved under.

// TODO: tune. Abandoned-cart nudge fires this long after checkout
// starts, unless the cart converts to an order first.
const ABANDONED_CART_DELAY_MS = 60 * 60 * 1000 // 1 hour
// TODO: tune. COD follow-up nudge fires this long after order
// placement, unless the order ships first.
const COD_FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000 // 24 hours

const HANDLED_TOPICS = new Set([
  'orders/create',
  'orders/cancelled',
  'refunds/create',
  'fulfillments/create',
  'fulfillments/update',
  'checkouts/create',
])

// ------------------------------------------------------------
// Shopify payload shapes — only the fields we read. Full payloads
// carry a lot more; keep these narrow so a schema drift elsewhere in
// the payload can't silently break a field we depend on.
// ------------------------------------------------------------

interface ShopifyAddress {
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  country_code?: string | null
}

interface ShopifyOrderPayload {
  id: number
  name?: string
  financial_status?: string | null
  gateway?: string | null
  payment_gateway_names?: string[]
  phone?: string | null
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null
  shipping_address?: ShopifyAddress | null
  billing_address?: ShopifyAddress | null
  /** Shopify sets one or both when the order originated from a checkout. */
  checkout_token?: string | null
  cart_token?: string | null
  /** Decimal string, e.g. "698.00" — feeds cod_order_amount / prepaid_order_amount. */
  total_price?: string | null
}

interface ShopifyRefundPayload {
  id: number
  order_id: number
}

interface ShopifyFulfillmentPayload {
  id: number
  order_id: number
  status?: string | null
  shipment_status?: string | null
  tracking_number?: string | null
  destination?: ShopifyAddress | null
}

interface ShopifyCheckoutPayload {
  token?: string | null
  phone?: string | null
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null
  shipping_address?: ShopifyAddress | null
  billing_address?: ShopifyAddress | null
}

interface Recipient {
  rawPhone: string | null
  countryAlpha2: string | null
  contactName: string | null
}

interface TemplateSend {
  templateName: string
  language: string
  /**
   * All five directly-sent templates (order_placed_prepaid,
   * order_placed_cod, order_cancelled, shipped, order_delivered) are
   * `parameter_format: NAMED` in Meta — body values MUST be a named
   * object keyed by the template's actual {{param}} names, not a
   * positional array. See the per-handler call sites below for the
   * confirmed key set per template.
   */
  body: Record<string, string>
}

// ------------------------------------------------------------
// POST
// ------------------------------------------------------------

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-shopify-hmac-sha256')
  const topic = request.headers.get('x-shopify-topic')
  const shopDomain = request.headers.get('x-shopify-shop-domain')
  const webhookId = request.headers.get('x-shopify-webhook-id')

  if (!topic || !shopDomain || !webhookId) {
    return NextResponse.json({ error: 'Missing required Shopify headers' }, { status: 400 })
  }

  const db = supabaseAdmin()

  // Store lookup must happen before signature verification — the
  // secret is per-shop, and shop_domain is self-identifying (Shopify
  // sends it, not a secret), so there's no oracle risk in a 404 here.
  const { data: store, error: storeErr } = await db
    .from('shopify_stores')
    .select('account_id, webhook_secret')
    .eq('shop_domain', shopDomain)
    .maybeSingle()

  if (storeErr) {
    console.error('[shopify-webhook] store lookup failed:', storeErr.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!store) {
    console.warn('[shopify-webhook] unknown shop_domain:', shopDomain)
    return NextResponse.json({ error: 'Unknown shop' }, { status: 404 })
  }

  const secret = decrypt(store.webhook_secret)
  if (!verifyShopifyWebhookSignature(rawBody, signature, secret)) {
    console.warn('[shopify-webhook] rejected request with invalid signature', { shopDomain })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Dedupe — insert-first (not select-then-insert) so two concurrent
  // deliveries of the same event id can't both pass a check and both
  // send. A unique-violation IS the duplicate signal.
  const { error: dedupeErr } = await db
    .from('shopify_webhook_events')
    .insert({ event_id: webhookId, shop_domain: shopDomain, topic, status: 'received' })

  if (dedupeErr) {
    if (isUniqueViolation(dedupeErr)) {
      // Already processed (or in flight) — ack without reprocessing.
      return NextResponse.json({ ok: true, deduped: true }, { status: 200 })
    }
    console.error('[shopify-webhook] dedupe insert failed:', dedupeErr.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  if (!HANDLED_TOPICS.has(topic)) {
    await markEvent(db, webhookId, 'skipped', `unhandled topic: ${topic}`)
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    await markEvent(db, webhookId, 'failed', 'invalid JSON body')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack now; do the mapping + send after the response is flushed so
  // Shopify's delivery timeout can't turn a slow Meta call into a
  // retry (which would otherwise race the dedupe row we already own).
  after(async () => {
    try {
      await processEvent({ db, accountId: store.account_id, shopDomain, topic, webhookId, payload })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[shopify-webhook] processing threw:', { shopDomain, topic, webhookId, message })
      await markEvent(db, webhookId, 'failed', message)
    }
  })

  return NextResponse.json({ ok: true }, { status: 200 })
}

// ------------------------------------------------------------
// Processing — one handler per topic.
// ------------------------------------------------------------

async function processEvent(args: {
  db: SupabaseClient
  accountId: string
  shopDomain: string
  topic: string
  webhookId: string
  payload: unknown
}): Promise<void> {
  const { db, accountId, shopDomain, topic, webhookId, payload } = args

  switch (topic) {
    case 'orders/create':
      return handleOrderCreate(db, accountId, shopDomain, webhookId, payload as ShopifyOrderPayload)
    case 'orders/cancelled':
      return handleOrderCancelled(db, accountId, webhookId, payload as ShopifyOrderPayload)
    case 'refunds/create':
      return handleRefundCreate(db, accountId, webhookId, payload as ShopifyRefundPayload)
    case 'fulfillments/create':
      return handleFulfillmentCreate(db, accountId, webhookId, payload as ShopifyFulfillmentPayload)
    case 'fulfillments/update':
      return handleFulfillmentUpdate(db, accountId, webhookId, payload as ShopifyFulfillmentPayload)
    case 'checkouts/create':
      return handleCheckoutCreate(db, accountId, shopDomain, webhookId, payload as ShopifyCheckoutPayload)
    default:
      await markEvent(db, webhookId, 'skipped', `no handler for topic "${topic}"`)
  }
}

async function handleOrderCreate(
  db: SupabaseClient,
  accountId: string,
  shopDomain: string,
  webhookId: string,
  order: ShopifyOrderPayload,
): Promise<void> {
  const recipient = extractOrderRecipient(order)
  const isPrepaid = guessIsPrepaid(order)
  const orderNumber = order.name ?? String(order.id)
  const firstName = recipient.contactName?.split(' ')[0] || 'there'
  const amount = formatOrderAmount(order.total_price)
  const normalizedPhone = normalizeShopifyPhone(recipient.rawPhone, recipient.countryAlpha2)

  // Cache order facts fulfillments/update (out_for_delivery) and
  // refunds/create need later — neither payload carries payment info,
  // and refunds/create carries no contact info at all. Re-fetching
  // from Shopify's Admin API per event was the alternative; this is a
  // one-time local snapshot instead. See migration 041 for the full
  // rationale (including why it's fine for this to go stale and why
  // there's no cleanup/expiry). Best-effort: a failure here doesn't
  // block the primary send below, and a duplicate orders/create-shaped
  // redelivery (Shopify's own redelivery quirks — see the file header
  // comment) is a no-op via the unique violation on order_id.
  const { error: cacheErr } = await db.from('shopify_order_cache').insert({
    account_id: accountId,
    shop_domain: shopDomain,
    order_id: String(order.id),
    order_name: orderNumber,
    order_amount: amount,
    is_prepaid: isPrepaid,
    customer_first_name: firstName,
    customer_phone: normalizedPhone,
  })
  if (cacheErr && !isUniqueViolation(cacheErr)) {
    console.error('[shopify-webhook] failed to cache order data:', cacheErr.message)
  }

  // order_placed_prepaid: { first_name, order_number, prepaid_order_amount }
  // order_placed_cod:     { first_name, order_number, cod_order_amount }
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: isPrepaid ? 'order_placed_prepaid' : 'order_placed_cod',
    language: LANGUAGE,
    body: isPrepaid
      ? { first_name: firstName, order_number: orderNumber, prepaid_order_amount: amount }
      : { first_name: firstName, order_number: orderNumber, cod_order_amount: amount },
  })

  // The cart converted — cancel any pending abandoned_cart reminder
  // for the checkout this order came from, if we can identify it.
  const checkoutToken = order.checkout_token ?? order.cart_token
  if (checkoutToken) {
    const { error } = await db
      .from('shopify_scheduled_notifications')
      .update({ status: 'cancelled' })
      .eq('kind', 'abandoned_cart')
      .eq('reference_id', checkoutToken)
      .eq('status', 'pending')
    if (error) {
      console.error('[shopify-webhook] failed to cancel abandoned_cart reminder:', error.message)
    }
  }

  // COD orders get a delayed follow-up nudge, cancelled if the order
  // ships before it fires (see handleFulfillmentCreate).
  if (!isPrepaid) {
    const phone = normalizedPhone
    if (phone) {
      const { error } = await db.from('shopify_scheduled_notifications').insert({
        account_id: accountId,
        shop_domain: shopDomain,
        kind: 'cod_followup',
        reference_id: String(order.id),
        phone,
        contact_name: recipient.contactName,
        template_name: 'cod_followup',
        language: LANGUAGE,
        // ⚠️ STILL BROKEN — left as a positional array on purpose.
        // cod_followup is NAMED and needs { saving_amount, first_name,
        // cod_amount, prepaid_amount, saving_amount1, prepaid_amount1 }
        // — a prepaid-discount amount/rate this webhook has no source
        // for (Shopify's order payload carries no such field; it's a
        // merchant-defined discount rule). This array WILL throw
        // "uses NAMED parameters" when the cron drains it — needs a
        // discount source wired before cod_followup can send at all.
        body: [firstName, orderNumber],
        run_at: new Date(Date.now() + COD_FOLLOWUP_DELAY_MS).toISOString(),
      })
      if (error && !isUniqueViolation(error)) {
        console.error('[shopify-webhook] failed to schedule cod_followup:', error.message)
      }
    }
  }
}

async function handleOrderCancelled(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  order: ShopifyOrderPayload,
): Promise<void> {
  const recipient = extractOrderRecipient(order)
  const orderNumber = order.name ?? String(order.id)
  const firstName = recipient.contactName?.split(' ')[0] || 'there'
  // order_cancelled: { first_name, order_number }
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: 'order_cancelled',
    language: LANGUAGE,
    body: { first_name: firstName, order_number: orderNumber },
  })
}

async function handleRefundCreate(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  refund: ShopifyRefundPayload,
): Promise<void> {
  // Shopify's Refund payload carries `order_id` only — no customer,
  // shipping_address, or phone at all. Now unblocked via
  // shopify_order_cache (migration 041), populated by handleOrderCreate
  // at orders/create time. A miss (order predates the cache, or its
  // orders/create webhook failed/was missed) means there's still no
  // contact info to send to — skip rather than guess, same as before
  // the cache existed, just with a more specific reason.
  const cached = await getOrderCache(db, refund.order_id)
  if (!cached) {
    await markEvent(
      db,
      webhookId,
      'skipped',
      `refunds/create: no shopify_order_cache row for order ${refund.order_id} — refunds/create payload carries no contact info of its own`,
    )
    return
  }

  if (!cached.is_prepaid) {
    // refund_prepaid is the only refund template in this catalog —
    // there's no refund_cod counterpart, and its copy ("refunded to
    // your original payment method") doesn't describe a COD order,
    // where nothing was collected upfront to refund. Skip rather than
    // send it anyway. Revisit if COD refunds turn out to be common
    // enough to justify a new template.
    await markEvent(
      db,
      webhookId,
      'skipped',
      'refund on COD order — no refund_cod template exists yet',
    )
    return
  }

  const recipient: Recipient = {
    rawPhone: cached.customer_phone,
    countryAlpha2: null,
    contactName: cached.customer_first_name,
  }

  // refund_prepaid: { first_name, order_number, prepaid_order_amount }
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: 'refund_prepaid',
    language: LANGUAGE,
    body: {
      first_name: cached.customer_first_name,
      order_number: cached.order_name,
      prepaid_order_amount: cached.order_amount,
    },
  })
}

async function handleFulfillmentCreate(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  fulfillment: ShopifyFulfillmentPayload,
): Promise<void> {
  const recipient = extractFulfillmentRecipient(fulfillment)
  const firstName = recipient.contactName?.split(' ')[0] || 'there'
  const cached = await getOrderCache(db, fulfillment.order_id)
  // order_number: prefer the cached order_name (the "#1234" display
  // format) from orders/create; fall back to the raw numeric order_id
  // on a cache miss (order placed before this cache existed, or its
  // orders/create webhook failed/was missed) — same fallback this
  // handler always used before the cache existed. Unlike the
  // out_for_delivery / refund_prepaid branches elsewhere in this file,
  // a miss here doesn't block the send: `shipped` can go out correctly
  // either way, it's the display format that degrades, not the
  // decision of whether to send at all — so this isn't a guess.
  const orderNumber = cached?.order_name ?? String(fulfillment.order_id)
  // shipped: { first_name, order_number, tracking_id }
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: 'shipped',
    language: LANGUAGE,
    body: {
      first_name: firstName,
      order_number: orderNumber,
      tracking_id: fulfillment.tracking_number ?? '',
    },
  })

  // The order started shipping — cancel any pending cod_followup nudge.
  const { error } = await db
    .from('shopify_scheduled_notifications')
    .update({ status: 'cancelled' })
    .eq('kind', 'cod_followup')
    .eq('reference_id', String(fulfillment.order_id))
    .eq('status', 'pending')
  if (error) {
    console.error('[shopify-webhook] failed to cancel cod_followup reminder:', error.message)
  }
}

async function handleFulfillmentUpdate(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  fulfillment: ShopifyFulfillmentPayload,
): Promise<void> {
  const recipient = extractFulfillmentRecipient(fulfillment)
  const firstName = recipient.contactName?.split(' ')[0] || 'there'
  const status = fulfillment.shipment_status

  if (!status) {
    // Distinct from "an explicit status we don't map" below — we
    // don't yet know whether this store's carrier setup ever
    // populates shipment_status on fulfillments/update at all, so
    // call out "never reports this" separately from "reported
    // something unmapped" rather than folding both into one generic
    // reason.
    await markEvent(
      db,
      webhookId,
      'skipped',
      'shipment_status not populated for this fulfillment',
    )
    return
  }

  if (status === 'delivered') {
    // order_delivered: { first_name }
    await sendTemplateAndMark(db, accountId, webhookId, recipient, {
      templateName: 'order_delivered',
      language: LANGUAGE,
      body: { first_name: firstName },
    })
    return
  }

  if (status === 'out_for_delivery') {
    // Payment-kind resolution: confirmed against Shopify's Fulfillment
    // REST resource docs that the object has no financial_status /
    // gateway / payment_gateway_names at all — it's a shipping
    // resource, that data only exists on the Order payload. Now
    // unblocked via shopify_order_cache (migration 041), populated by
    // handleOrderCreate at orders/create time. A miss (order predates
    // the cache, or its orders/create webhook failed/was missed) means
    // there's still no way to pick prepaid vs cod without guessing —
    // skip rather than default to one, same as before the cache
    // existed, just with a more specific reason.
    const cached = await getOrderCache(db, fulfillment.order_id)
    if (!cached) {
      await markEvent(
        db,
        webhookId,
        'skipped',
        'out_for_delivery: no shopify_order_cache row for this order_id — cannot determine prepaid/cod or the order amount',
      )
      return
    }

    const trackingId = fulfillment.tracking_number ?? ''
    if (cached.is_prepaid) {
      // out_for_delivery_prepaid: { first_name, order_number, tracking_id }
      await sendTemplateAndMark(db, accountId, webhookId, recipient, {
        templateName: 'out_for_delivery_prepaid',
        language: LANGUAGE,
        body: {
          first_name: firstName,
          order_number: cached.order_name,
          tracking_id: trackingId,
        },
      })
    } else {
      // out_for_delivery_cod: { first_name, order_number, cod_amount, tracking_id }
      await sendTemplateAndMark(db, accountId, webhookId, recipient, {
        templateName: 'out_for_delivery_cod',
        language: LANGUAGE,
        body: {
          first_name: firstName,
          order_number: cached.order_name,
          cod_amount: cached.order_amount,
          tracking_id: trackingId,
        },
      })
    }
    return
  }

  // Any other shipment_status (in_transit, label_printed, confirmed,
  // …) — no template mapped; don't message on every minor tracking tick.
  await markEvent(
    db,
    webhookId,
    'skipped',
    `fulfillments/update: no template for shipment_status "${status}"`,
  )
}

async function handleCheckoutCreate(
  db: SupabaseClient,
  accountId: string,
  shopDomain: string,
  webhookId: string,
  checkout: ShopifyCheckoutPayload,
): Promise<void> {
  if (!checkout.token) {
    await markEvent(db, webhookId, 'skipped', 'checkouts/create: payload missing checkout token')
    return
  }

  const addr = checkout.shipping_address ?? checkout.billing_address
  const rawPhone = addr?.phone ?? checkout.customer?.phone ?? checkout.phone ?? null
  const countryAlpha2 = addr?.country_code ?? null
  const first = addr?.first_name ?? checkout.customer?.first_name ?? ''
  const last = addr?.last_name ?? checkout.customer?.last_name ?? ''
  const contactName = [first, last].filter(Boolean).join(' ').trim() || null

  const phone = normalizeShopifyPhone(rawPhone, countryAlpha2)
  if (!phone) {
    await markEvent(db, webhookId, 'skipped', 'checkouts/create: no usable phone to schedule an abandoned_cart reminder')
    return
  }

  const firstName = contactName?.split(' ')[0] || 'there'
  const runAt = new Date(Date.now() + ABANDONED_CART_DELAY_MS)
  const { error } = await db.from('shopify_scheduled_notifications').insert({
    account_id: accountId,
    shop_domain: shopDomain,
    kind: 'abandoned_cart',
    reference_id: checkout.token,
    phone,
    contact_name: contactName,
    template_name: 'abandoned_cart',
    language: LANGUAGE,
    // abandoned_cart: { first_name } — NAMED. The button's own {{1}}
    // dynamic suffix (magic_order_id) is positional and separate from
    // this body object — not wired here yet; see the cron route.
    body: { first_name: firstName },
    run_at: runAt.toISOString(),
  })

  if (error) {
    if (isUniqueViolation(error)) {
      // checkouts/update can redeliver a checkouts/create-shaped event
      // for the same token — a repeat schedule attempt is a no-op.
      await markEvent(db, webhookId, 'skipped', 'abandoned_cart reminder already scheduled for this checkout')
      return
    }
    console.error('[shopify-webhook] failed to schedule abandoned_cart:', error.message)
    await markEvent(db, webhookId, 'failed', error.message)
    return
  }

  await markEvent(db, webhookId, 'scheduled', `abandoned_cart reminder scheduled for ${runAt.toISOString()}`)
}

// ------------------------------------------------------------
// Shared send path
// ------------------------------------------------------------

async function sendTemplateAndMark(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  recipient: Recipient,
  send: TemplateSend,
): Promise<void> {
  const phone = normalizeShopifyPhone(recipient.rawPhone, recipient.countryAlpha2)
  if (!phone) {
    const reason = recipient.rawPhone
      ? 'phone number could not be normalized to E.164'
      : 'no phone number present in webhook payload'
    console.warn('[shopify-webhook] skipping send — bad phone', { accountId, webhookId, reason })
    await markEvent(db, webhookId, 'skipped', reason)
    return
  }

  try {
    const resolved = await resolveConversationByPhone(db, accountId, phone, recipient.contactName)
    const result = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      templateName: send.templateName,
      templateLanguage: send.language,
      // Object form throughout (not the legacy array param) — it's a
      // strict superset (supports `body` plus, when needed later,
      // `headerMediaUrl`/`headerMediaId`/`buttonParams`), and
      // `sendMessageToConversation` already loads the template row and
      // falls back to the template's own stored `header_media_url` for
      // any static image/video/document header, so no per-send
      // override is needed unless a template wants a dynamic per-order
      // image.
      templateMessageParams: { body: send.body },
    })
    await markEvent(db, webhookId, 'sent', `${send.templateName} (${result.whatsappMessageId})`)
  } catch (err) {
    const message =
      err instanceof SendMessageError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
    console.error('[shopify-webhook] send failed:', {
      accountId,
      webhookId,
      templateName: send.templateName,
      message,
    })
    await markEvent(db, webhookId, 'failed', message)
  }
}

// ------------------------------------------------------------
// Order cache reads — see migration 041 for what's cached and why.
// ------------------------------------------------------------

interface OrderCacheRow {
  order_name: string
  order_amount: string
  is_prepaid: boolean
  customer_first_name: string
  customer_phone: string | null
}

/**
 * A lookup failure (transient DB error) is treated the same as a miss
 * (`null`) by every call site — logged here so it's not silently
 * swallowed, but callers can't act on "error vs genuinely no row"
 * differently anyway; both mean "no order data available right now",
 * same skip-and-log response either way.
 */
async function getOrderCache(
  db: SupabaseClient,
  orderId: number,
): Promise<OrderCacheRow | null> {
  const { data, error } = await db
    .from('shopify_order_cache')
    .select('order_name, order_amount, is_prepaid, customer_first_name, customer_phone')
    .eq('order_id', String(orderId))
    .maybeSingle()
  if (error) {
    console.error('[shopify-webhook] order cache lookup failed:', error.message)
    return null
  }
  return data as OrderCacheRow | null
}

// ------------------------------------------------------------
// Recipient extraction
// ------------------------------------------------------------

function extractOrderRecipient(order: ShopifyOrderPayload): Recipient {
  const addr = order.shipping_address ?? order.billing_address
  const first = addr?.first_name ?? order.customer?.first_name ?? ''
  const last = addr?.last_name ?? order.customer?.last_name ?? ''
  return {
    rawPhone: addr?.phone ?? order.customer?.phone ?? order.phone ?? null,
    countryAlpha2: addr?.country_code ?? null,
    contactName: [first, last].filter(Boolean).join(' ').trim() || null,
  }
}

function extractFulfillmentRecipient(fulfillment: ShopifyFulfillmentPayload): Recipient {
  const dest = fulfillment.destination
  const first = dest?.first_name ?? ''
  const last = dest?.last_name ?? ''
  return {
    rawPhone: dest?.phone ?? null,
    countryAlpha2: dest?.country_code ?? null,
    contactName: [first, last].filter(Boolean).join(' ').trim() || null,
  }
}

/** TODO: guessed heuristic — confirm your actual COD detection rule. */
function guessIsPrepaid(order: ShopifyOrderPayload): boolean {
  if (order.financial_status === 'paid') return true
  const gatewayNames = [order.gateway, ...(order.payment_gateway_names ?? [])]
    .filter((g): g is string => Boolean(g))
    .map((g) => g.toLowerCase())
  if (gatewayNames.some((g) => g.includes('cash on delivery') || g.includes('cod'))) {
    return false
  }
  // Default to prepaid when ambiguous — TODO: confirm this is the
  // right fallback direction for your store's gateway setup.
  return order.financial_status !== 'pending'
}

/**
 * Shopify's `total_price` is a decimal string like "698.00". The
 * templates' sample values show whole-rupee amounts ("698", no
 * decimals) — strip a trailing ".00" so the sent message matches.
 * Amounts with real cents (e.g. "698.50") are left as-is.
 */
function formatOrderAmount(totalPrice: string | null | undefined): string {
  if (!totalPrice) return ''
  return totalPrice.replace(/\.00$/, '')
}

// ------------------------------------------------------------
// Dedupe-row status updates — this row is the "why didn't it send"
// log; query `shopify_webhook_events` directly instead of Vercel logs.
// ------------------------------------------------------------

async function markEvent(
  db: SupabaseClient,
  eventId: string,
  status: 'sent' | 'scheduled' | 'skipped' | 'failed',
  detail: string,
): Promise<void> {
  if (!eventId) return
  const { error } = await db
    .from('shopify_webhook_events')
    .update({ status, error_message: detail })
    .eq('event_id', eventId)
  if (error) {
    console.error('[shopify-webhook] failed to update event status:', error.message)
  }
}
