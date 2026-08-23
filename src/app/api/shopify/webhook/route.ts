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
//   fulfillments/update  → order_delivered (shipment_status=delivered)
//                           out_for_delivery_* currently SKIPPED — see
//                           the out_for_delivery note below.
//   refunds/create        → refund_prepaid, currently SKIPPED — see the
//                            refunds/create note below.
//
// Topics handled via the deferred-send queue (`shopify_scheduled_notifications`,
// drained by `/api/cron/shopify-notifications`) because they aren't a
// single-event trigger:
//   checkouts/create → schedules abandoned_cart, cancelled if the same
//                       checkout_token shows up on a later orders/create.
//   (orders/create, when COD) → schedules cod_followup, cancelled if
//                       the same order_id gets a fulfillments/create.
//
// Known gaps, deliberately left unresolved (confirmed in chat):
//   - out_for_delivery_prepaid vs out_for_delivery_cod: fulfillment
//     payloads carry no payment info, only order_id. Resolving this
//     (a local order→payment-kind cache, or an Admin API refetch) was
//     explicitly deferred — `handleFulfillmentUpdate` always skips
//     out_for_delivery rather than guessing.
//   - refunds/create: the Refund payload carries only `order_id`, no
//     customer/shipping_address/phone at all. Same category of gap as
//     above (needs an order_id → contact lookup); `handleRefundCreate`
//     always skips with a clear reason rather than guessing or crashing.
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
  body: string[]
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
      return handleRefundCreate(db, webhookId, payload as ShopifyRefundPayload)
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

  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: isPrepaid ? 'order_placed_prepaid' : 'order_placed_cod',
    language: LANGUAGE,
    body: [firstName, orderNumber], // TODO: confirm {{1}}/{{2}}/… order per template.
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
    const phone = normalizeShopifyPhone(recipient.rawPhone, recipient.countryAlpha2)
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
        body: [firstName, orderNumber], // TODO: confirm.
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
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: 'order_cancelled',
    language: LANGUAGE,
    body: [firstName, orderNumber], // TODO: confirm.
  })
}

async function handleRefundCreate(
  db: SupabaseClient,
  webhookId: string,
  refund: ShopifyRefundPayload,
): Promise<void> {
  // Shopify's Refund payload carries `order_id` only — no customer,
  // shipping_address, or phone. Sending refund_prepaid needs an
  // order_id → contact lookup this route doesn't have (same category
  // of gap as out_for_delivery's payment-kind lookup, deferred in
  // chat) — skip with a specific reason rather than guessing.
  await markEvent(
    db,
    webhookId,
    'skipped',
    `refunds/create: no contact info in payload for order ${refund.order_id} — order_id→phone lookup not wired`,
  )
}

async function handleFulfillmentCreate(
  db: SupabaseClient,
  accountId: string,
  webhookId: string,
  fulfillment: ShopifyFulfillmentPayload,
): Promise<void> {
  const recipient = extractFulfillmentRecipient(fulfillment)
  const firstName = recipient.contactName?.split(' ')[0] || 'there'
  await sendTemplateAndMark(db, accountId, webhookId, recipient, {
    templateName: 'shipped',
    language: LANGUAGE,
    body: [firstName, fulfillment.tracking_number ?? ''], // TODO: confirm.
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

  if (fulfillment.shipment_status === 'delivered') {
    await sendTemplateAndMark(db, accountId, webhookId, recipient, {
      templateName: 'order_delivered',
      language: LANGUAGE,
      body: [firstName], // TODO: confirm.
    })
    return
  }

  if (fulfillment.shipment_status === 'out_for_delivery') {
    // Payment-kind resolution deferred per your answer (fulfillment
    // payloads carry no financial_status/gateway) — skip rather than
    // guess prepaid vs cod.
    await markEvent(
      db,
      webhookId,
      'skipped',
      'out_for_delivery: prepaid/cod detection deferred — see route.ts header comment',
    )
    return
  }

  // Any other shipment_status (in_transit, label_printed, confirmed,
  // …) — no template mapped; don't message on every minor tracking tick.
  await markEvent(
    db,
    webhookId,
    'skipped',
    `fulfillments/update: no template for shipment_status "${fulfillment.shipment_status ?? ''}"`,
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
    body: [firstName], // TODO: confirm — e.g. cart items / a recovery link.
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
