import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * Turn Razorpay's abandoned-cart `phone` field into the digit string
 * `sanitizePhoneForMeta`/`resolveConversationByPhone` expect.
 *
 * Unlike Shopify (`lib/shopify/phone-normalize.ts`), Razorpay's sample
 * payload already carries `phone` fully E.164-formatted with a leading
 * `+` (e.g. `"+919999999999"`) — no `country_code`-driven guessing
 * needed here, so this is just a strip-and-validate pass rather than
 * `normalizeShopifyPhone`'s calling-code-prefix heuristic.
 *
 * Returns `null` — never throws — when the result still isn't a
 * plausible E.164 number (e.g. Razorpay ever sends a bare local
 * number for some integration path), so the caller can log-and-skip
 * instead of sending to a malformed recipient. If that turns out to
 * happen in practice, this is the place to add a fallback — not a
 * silent guess.
 */
export function normalizeRazorpayPhone(
  rawPhone: string | null | undefined,
): string | null {
  if (!rawPhone) return null
  const trimmed = rawPhone.trim()
  if (!trimmed) return null

  const sanitized = sanitizePhoneForMeta(trimmed)
  return isValidE164(sanitized) ? sanitized : null
}
