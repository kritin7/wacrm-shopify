import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Shopify attaches to webhook POSTs.
 *
 * Shopify signs the raw request body with the webhook's signing
 * secret (issued per-subscription, stored per-shop in
 * `shopify_stores.webhook_secret`) and sends the base64-encoded
 * result in the `X-Shopify-Hmac-Sha256` header — base64, NOT the hex
 * + `sha256=` prefix scheme Meta uses (see
 * `lib/whatsapp/webhook-signature.ts`), so this is a distinct helper
 * rather than a shared one.
 *
 * Reference:
 *   https://shopify.dev/docs/apps/build/webhooks/subscribe/verify-webhook-signatures
 *
 * Without verification, anyone who learns the webhook URL could POST
 * fabricated orders/fulfillments and trigger arbitrary WhatsApp sends
 * to arbitrary phone numbers under this account's WhatsApp number.
 */
export function verifyShopifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')

  let a: Buffer
  let b: Buffer
  try {
    a = Buffer.from(signatureHeader, 'base64')
    b = Buffer.from(expected, 'base64')
  } catch {
    return false
  }
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
