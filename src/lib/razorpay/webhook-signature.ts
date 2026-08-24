import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Razorpay attaches to webhook POSTs
 * (including the Magic Checkout abandoned-cart webhook).
 *
 * Razorpay signs the raw request body with the webhook's secret and
 * sends the result as a lowercase hex digest in the
 * `X-Razorpay-Signature` header — hex, NOT base64 (Shopify's scheme —
 * see `lib/shopify/webhook-signature.ts`) and no `sha256=` prefix
 * (Meta's scheme — see `lib/whatsapp/webhook-signature.ts`). Three
 * providers, three encodings — each gets its own verifier rather than
 * a shared one that has to branch on shape.
 *
 * Reference: https://razorpay.com/docs/webhooks/validate-test/
 *   "The hash signature is calculated using HMAC with SHA256
 *   algorithm; with your webhook secret set as the key and the
 *   webhook request body as the message."
 *
 * Without verification, anyone who learns the webhook URL could POST
 * fabricated abandoned-cart events and trigger arbitrary WhatsApp
 * sends to arbitrary phone numbers under this account's WhatsApp
 * number.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')

  // Reject non-hex headers up front — Buffer.from(str, 'hex') silently
  // stops at the first invalid pair instead of throwing, which would
  // otherwise let a malformed header produce a shorter Buffer that
  // coincidentally fails the length check for the wrong reason.
  if (!/^[0-9a-f]+$/i.test(signatureHeader)) return false

  const a = Buffer.from(signatureHeader, 'hex')
  const b = Buffer.from(expected, 'hex')
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
