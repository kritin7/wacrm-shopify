// ============================================================
// POST /api/razorpay/abandoned-cart — Razorpay Magic Checkout
// abandoned-cart events → WhatsApp `abandoned_cart` template.
//
// A second, independent abandoned-cart source alongside Shopify's
// (`/api/shopify/webhook`'s checkouts/create path) — different
// provider, different payload shape, no shared state between the two
// sources. Deliberately NOT wired into shopify_stores /
// shopify_webhook_events / shopify_scheduled_notifications — separate
// tables (040), separate route. Both happen to target the same
// `abandoned_cart` template row.
//
// Authentication: NOT HMAC-signed. Confirmed against Razorpay's docs
// that the Magic Checkout abandoned-cart webhook — unlike Razorpay's
// general payment webhooks (X-Razorpay-Signature) — carries no
// signature or secret of its own; there's nothing to verify a request
// against. So this route relies on a shared secret WE generate and
// register into the URL ourselves: a random token stored in
// `razorpay_stores.webhook_secret` (plaintext — see the storage note
// on that column, migration 040) that the registered webhook URL
// carries as `?key=`. A request with a missing or wrong `key` is
// rejected before any processing. This is weaker than HMAC (a leaked
// URL — e.g. captured in a proxy/CDN access log that logs full
// request URLs by default, which Vercel's own request log does — is
// enough to forge requests, whereas HMAC additionally requires
// tampering detection per-payload) but it's the only mechanism
// available here; there's no signature to fall back to.
//
// Send timing (confirmed in chat): Razorpay's own abandonment delay
// has already elapsed by the time this webhook fires — the cart is
// confirmed abandoned on delivery, unlike Shopify's checkouts/create
// (which fires at checkout *start* and needs wacrm's own delay queue,
// shopify_scheduled_notifications). So this route sends directly in
// `after()`, mirroring Shopify's orders/create → sendTemplateAndMark
// path, NOT its checkouts/create → scheduled-notification path. If
// that assumption turns out wrong (Razorpay refires per cart edit, or
// doesn't actually delay), the fix is a razorpay_scheduled_notifications
// table + cron drain route, same shape as 038 — not built here since
// it wasn't confirmed as needed.
//
// Flow per delivery:
//   1. Read the raw body and parse it to read `shop_id` — Razorpay
//      has no shop-identifying *header* the way Shopify sends
//      X-Shopify-Shop-Domain, so the routing key has to come from the
//      body itself. shop_id isn't a secret (Razorpay sends it, same
//      self-identifying status as Shopify's shop_domain), so looking
//      a store up by it before checking `?key=` carries no oracle
//      risk.
//   2. Check the `key` query param against that store's
//      `webhook_secret`, exact match, timing-safe. Reject (401) if
//      missing or wrong.
//   3. Dedupe on `x-razorpay-event-id` (Razorpay's docs: "unique per
//      event" — redelivery behavior isn't documented as explicitly as
//      Shopify's, so this dedupes defensively regardless).
//   4. Ack 200 immediately; do the actual mapping + send in `after()`
//      so Razorpay's delivery timeout never turns into a retry storm.
//   5. Record the outcome back onto the dedupe row (`sent` / `skipped`
//      / `failed` + a reason) — mirrors shopify_webhook_events as the
//      "why didn't this message go out" log.
//
// Known gap, deliberately left unresolved (flagged, not guessed):
//   - abandoned_cart's URL button carries a positional {{1}} suffix
//     (`.../cart?magic_order_id=order_{{1}}`) that this route does NOT
//     populate. The abandoned-cart payload has two candidate fields —
//     `token` (session token) and `cart_token` (cart identifier,
//     "c1-..." prefixed) — and it's unconfirmed which one (if either)
//     is what Razorpay's own magic_order_id recovery links actually
//     use. Confirm against a real Razorpay-generated recovery URL
//     before wiring `buttonParams`; sending the wrong id would produce
//     a broken "Complete your Purchase" link. Same category of gap as
//     the Shopify route's cod_followup discount-amount TODO — sends
//     without it (body still goes out correctly) rather than guessing
//     or blocking the integration on it.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { normalizeRazorpayPhone } from '@/lib/razorpay/phone-normalize'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// Ack Razorpay fast; the real work runs in `after()`, which shares
// this same execution's time budget on Vercel. 30s is generous
// headroom for one Meta send + a couple of Supabase round-trips.
export const maxDuration = 30

const LANGUAGE = 'en' // matches the `language` abandoned_cart was approved under (confirmed via message_templates).
const TEMPLATE_NAME = 'abandoned_cart'

// ------------------------------------------------------------
// Razorpay Magic Checkout abandoned-cart payload — only the fields we
// read. Shape confirmed against Razorpay's published sample payload
// (docs/payments/magic-checkout/abandoned-cart) — kept narrow so
// schema drift elsewhere in the payload can't silently break a field
// we depend on.
// ------------------------------------------------------------

interface RazorpayCustomer {
  first_name?: string | null
  last_name?: string | null
}

interface RazorpayAbandonedCartPayload {
  shop_id?: string | null
  /** Session token — one of two candidates for the button's {{1}}; unconfirmed which. */
  token?: string | null
  /** Cart identifier ("c1-..." prefixed) — the other candidate; unconfirmed which. */
  cart_token?: string | null
  /** Already E.164-formatted per Razorpay's sample ("+919999999999"). */
  phone?: string | null
  customer?: RazorpayCustomer | null
}

// ------------------------------------------------------------
// POST
// ------------------------------------------------------------

export async function POST(request: Request) {
  const rawBody = await request.text()
  const providedKey = new URL(request.url).searchParams.get('key')
  const eventId = request.headers.get('x-razorpay-event-id')

  if (!eventId) {
    return NextResponse.json({ error: 'Missing x-razorpay-event-id header' }, { status: 400 })
  }

  let payload: RazorpayAbandonedCartPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const shopId = payload.shop_id
  if (!shopId) {
    return NextResponse.json({ error: 'Payload missing shop_id' }, { status: 400 })
  }

  const db = supabaseAdmin()

  // Store lookup must happen before the key check — the key is
  // per-shop, and shop_id is self-identifying (Razorpay sends it, not
  // a secret), so there's no oracle risk in a 404 here. Same reasoning
  // as the Shopify route's shop_domain lookup — see its header
  // comment.
  const { data: store, error: storeErr } = await db
    .from('razorpay_stores')
    .select('account_id, webhook_secret')
    .eq('shop_id', shopId)
    .maybeSingle()

  if (storeErr) {
    console.error('[razorpay-webhook] store lookup failed:', storeErr.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!store) {
    console.warn('[razorpay-webhook] unknown shop_id:', shopId)
    return NextResponse.json({ error: 'Unknown shop' }, { status: 404 })
  }

  // Shared-secret check — see the "Authentication" note in the header
  // comment for why this isn't HMAC. `webhook_secret` is stored
  // plaintext (not `encrypt()`'d — deliberate, see chat); the guard
  // below is length-then-timingSafeEqual, not `===`, for the same
  // reason the cron routes compare their shared secret this way
  // (avoid leaking a byte-by-byte timing oracle on the comparison).
  const expectedKey = store.webhook_secret as string
  // Fail closed on an unprovisioned secret — without this, an empty
  // `webhook_secret` and a missing `?key=` would both produce a
  // zero-length buffer, and the length check below would call that a
  // match before timingSafeEqual ever runs. Same fail-closed posture
  // as verifyMetaWebhookSignature's missing-secret guard.
  if (!expectedKey) {
    console.error('[razorpay-webhook] store has no webhook_secret configured', { shopId })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  const providedKeyBuf = Buffer.from(providedKey ?? '')
  const expectedKeyBuf = Buffer.from(expectedKey)
  if (
    providedKeyBuf.length !== expectedKeyBuf.length ||
    !timingSafeEqual(providedKeyBuf, expectedKeyBuf)
  ) {
    console.warn('[razorpay-webhook] rejected request with missing/wrong key', { shopId })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // (Key-check TEMP DEBUG from the earlier "missing/wrong key" 401
  // removed — confirmed resolved: reaching here means the check above
  // already passed. It also logged `requestUrl`, which legitimately
  // contains `?key=<hex>` — the likely source of the `?key=...` tail
  // that showed up glued onto `cartToken` below; that log was the one
  // adjacent line in the stream actually containing that substring.)

  // TEMP DEBUG — remove once we've captured one real payload and
  // confirmed which field (token vs cart_token) Razorpay's own
  // magic_order_id recovery links actually use (see the "Known gap"
  // note in the header comment). Logged post-auth only — this route
  // is otherwise unauthenticated up to this point, so logging payload
  // contents before the key check would let a spoofed request pollute
  // the logs. JSON.stringify + length on each field, same as the
  // earlier shop_id/key investigations, so a reader doesn't have to
  // eyeball raw values to rule out a hidden/trailing-character issue
  // (or, this time, confirm there's no stray `?key=...` actually
  // inside the JSON value itself, as opposed to an adjacent log line).
  console.log('[razorpay-webhook][debug] captured payload', {
    shopId,
    eventId,
    token: payload.token,
    tokenJSON: JSON.stringify(payload.token),
    tokenLength: payload.token?.length ?? null,
    cartToken: payload.cart_token,
    cartTokenJSON: JSON.stringify(payload.cart_token),
    cartTokenLength: payload.cart_token?.length ?? null,
  })

  // Dedupe — insert-first (not select-then-insert) so two concurrent
  // deliveries of the same event id can't both pass a check and both
  // send. A unique-violation IS the duplicate signal.
  const { error: dedupeErr } = await db
    .from('razorpay_webhook_events')
    .insert({ event_id: eventId, shop_id: shopId, status: 'received' })

  if (dedupeErr) {
    if (isUniqueViolation(dedupeErr)) {
      // Already processed (or in flight) — ack without reprocessing.
      return NextResponse.json({ ok: true, deduped: true }, { status: 200 })
    }
    console.error('[razorpay-webhook] dedupe insert failed:', dedupeErr.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  // Ack now; do the mapping + send after the response is flushed so
  // Razorpay's delivery timeout can't turn a slow Meta call into a
  // retry (which would otherwise race the dedupe row we already own).
  after(async () => {
    try {
      await processEvent({ db, accountId: store.account_id, eventId, payload })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[razorpay-webhook] processing threw:', { shopId, eventId, message })
      await markEvent(db, eventId, 'failed', message)
    }
  })

  return NextResponse.json({ ok: true }, { status: 200 })
}

// ------------------------------------------------------------
// Processing
// ------------------------------------------------------------

async function processEvent(args: {
  db: SupabaseClient
  accountId: string
  eventId: string
  payload: RazorpayAbandonedCartPayload
}): Promise<void> {
  const { db, accountId, eventId, payload } = args

  const phone = normalizeRazorpayPhone(payload.phone)
  if (!phone) {
    const reason = payload.phone
      ? 'phone number could not be normalized to E.164'
      : 'no phone number present in webhook payload'
    console.warn('[razorpay-webhook] skipping send — bad phone', { accountId, eventId, reason })
    await markEvent(db, eventId, 'skipped', reason)
    return
  }

  const first = payload.customer?.first_name ?? ''
  const last = payload.customer?.last_name ?? ''
  const contactName = [first, last].filter(Boolean).join(' ').trim() || null
  const firstName = payload.customer?.first_name?.trim() || 'there'

  try {
    const resolved = await resolveConversationByPhone(db, accountId, phone, contactName)
    const result = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      templateName: TEMPLATE_NAME,
      templateLanguage: LANGUAGE,
      // abandoned_cart: { first_name } — NAMED. The button's {{1}}
      // (magic_order_id) is intentionally NOT populated here — see
      // the route header comment on the token/cart_token gap.
      templateMessageParams: { body: { first_name: firstName } },
    })
    await markEvent(db, eventId, 'sent', `${TEMPLATE_NAME} (${result.whatsappMessageId})`)
  } catch (err) {
    const message =
      err instanceof SendMessageError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
    console.error('[razorpay-webhook] send failed:', { accountId, eventId, message })
    await markEvent(db, eventId, 'failed', message)
  }
}

// ------------------------------------------------------------
// Dedupe-row status updates — this row is the "why didn't it send"
// log, mirroring shopify_webhook_events.
// ------------------------------------------------------------

async function markEvent(
  db: SupabaseClient,
  eventId: string,
  status: 'sent' | 'scheduled' | 'skipped' | 'failed',
  detail: string,
): Promise<void> {
  if (!eventId) return
  const { error } = await db
    .from('razorpay_webhook_events')
    .update({ status, error_message: detail })
    .eq('event_id', eventId)
  if (error) {
    console.error('[razorpay-webhook] failed to update event status:', error.message)
  }
}
