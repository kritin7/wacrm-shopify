import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * ISO 3166-1 alpha-2 → international calling code (digits, no `+`).
 *
 * Shopify's `shipping_address.country_code` is alpha-2; Meta's `to`
 * field needs the calling code prepended when the customer typed a
 * domestic-format number with no country code at all (very common —
 * see `phone-utils.ts`'s `phoneVariants()`, which only handles a
 * missing/extra *trunk* 0 and assumes the country code is already
 * present).
 *
 * Not exhaustive — covers the countries wacrm merchants realistically
 * ship WhatsApp-notified orders to. An unmapped country code falls
 * through `normalizeShopifyPhone` to the best-effort digits-only path;
 * if that isn't a valid E.164 shape either, the caller logs and skips
 * rather than guessing. Extend this table as new countries come up.
 */
export const COUNTRY_CALLING_CODES: Record<string, string> = {
  US: '1', CA: '1', MX: '52', BR: '55', AR: '54', CL: '56', CO: '57', PE: '51',
  GB: '44', IE: '353', FR: '33', DE: '49', ES: '34', PT: '351', IT: '39',
  NL: '31', BE: '32', LU: '352', CH: '41', AT: '43', SE: '46', NO: '47',
  DK: '45', FI: '358', IS: '354', PL: '48', CZ: '420', SK: '421', HU: '36',
  RO: '40', BG: '359', GR: '30', TR: '90', RU: '7', UA: '380', LT: '370',
  LV: '371', EE: '372',
  IN: '91', PK: '92', BD: '880', LK: '94', NP: '977',
  CN: '86', HK: '852', MO: '853', TW: '886', JP: '81', KR: '82',
  SG: '65', MY: '60', ID: '62', PH: '63', TH: '66', VN: '84',
  AU: '61', NZ: '64',
  AE: '971', SA: '966', QA: '974', KW: '965', BH: '973', OM: '968',
  IL: '972', JO: '962', LB: '961', EG: '20',
  ZA: '27', NG: '234', KE: '254', GH: '233', TZ: '255', UG: '256',
}

/**
 * Turn a raw Shopify phone string (customer-typed — may or may not
 * include a country code, `+`, spaces, dashes, parens) into an E.164
 * digit string suitable for `sanitizePhoneForMeta`/`resolveConversationByPhone`,
 * using `countryAlpha2` (Shopify's `shipping_address.country_code`)
 * to fill in a missing country code.
 *
 * Returns `null` — never throws — when the result still isn't a
 * plausible E.164 number, so the caller can log-and-skip instead of
 * sending to a malformed recipient.
 */
export function normalizeShopifyPhone(
  rawPhone: string | null | undefined,
  countryAlpha2: string | null | undefined,
): string | null {
  if (!rawPhone) return null
  const trimmed = rawPhone.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  const hasExplicitPlus = trimmed.startsWith('+')
  const callingCode = countryAlpha2
    ? COUNTRY_CALLING_CODES[countryAlpha2.toUpperCase()]
    : undefined

  let candidate = digits
  if (!hasExplicitPlus && callingCode) {
    // Heuristic (same spirit as phoneVariants()'s trunk-0 handling):
    // only prepend if the digits don't already look like they start
    // with this calling code + a plausible national number. Without
    // the length check, a short national number that happens to start
    // with the same digit(s) as the calling code (e.g. calling code
    // "1", national number "12345678") would be mistaken for already
    // having a country code and left un-prefixed.
    const looksPrefixed =
      digits.startsWith(callingCode) && digits.length >= callingCode.length + 8
    if (!looksPrefixed) {
      candidate = callingCode + digits
    }
  }

  const sanitized = sanitizePhoneForMeta(candidate)
  return isValidE164(sanitized) ? sanitized : null
}
