// ============================================================
// POST /api/mc/abandoned-cart — alias for /api/razorpay/abandoned-cart.
//
// Razorpay's Magic Checkout dashboard (Setup & Settings → Platform
// Settings → Checkout Setup → abandoned-cart webhook URL field)
// silently rejects any URL containing the string "razorpay" — not
// documented anywhere, confirmed by testing. This route exists purely
// to give that field a URL without the word in it ("mc" = Magic
// Checkout); it re-exports the real handler rather than duplicating
// any logic, so there's exactly one implementation to maintain.
//
// Register THIS route's URL with Razorpay. Keep
// /api/razorpay/abandoned-cart/route.ts as the canonical
// implementation — this file must stay a pure re-export of POST.
//
// `maxDuration` is the one exception: Next.js extracts route segment
// config (maxDuration, runtime, …) via static AST analysis of literal
// `export const x = <value>` declarations IN THIS FILE — it does not
// follow `export { x } from '...'` re-exports (checked against
// next/dist/build/analysis/extract-const-value.js, which only matches
// an ExportDeclaration wrapping a VariableDeclaration). So it has to
// be repeated here, not re-exported, or this route would silently
// fall back to the platform's default timeout instead of the 30s the
// underlying handler's `after()` work needs. Keep this in sync with
// the value in the canonical route file.
// ============================================================

export const maxDuration = 30

export { POST } from '@/app/api/razorpay/abandoned-cart/route'
