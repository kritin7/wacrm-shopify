-- ============================================================
-- 040_razorpay_magic_checkout.sql — Razorpay Magic Checkout
-- abandoned-cart webhook → WhatsApp notification
--
-- A second, independent abandoned-cart *source* alongside Shopify's
-- (`shopify_stores` / `shopify_webhook_events`, 037) — different
-- provider, different payload shape, no shared rows or scheduling
-- state with Shopify's tables. Both sources target the same
-- `abandoned_cart` template.
--
-- Two tables, mirroring 037's shape exactly:
--
--   razorpay_stores — maps a Razorpay Magic Checkout store to the
--   wacrm account that should receive its abandoned-cart events, and
--   holds the per-store shared secret. Keyed on `shop_id` (the
--   `shop_id` field Razorpay includes in the webhook BODY, e.g.
--   "magic-checkout-test-store-1" — there's no shop-identifying
--   *header* the way Shopify sends `X-Shopify-Shop-Domain`, so the
--   webhook route parses the JSON body first to read `shop_id`, then
--   looks up the store by it).
--
--   razorpay_webhook_events — dedupe + outcome log for inbound
--   deliveries, keyed on Razorpay's `x-razorpay-event-id` header
--   ("unique per event" per Razorpay's docs — redelivery behavior on
--   non-2xx/timeout isn't documented as explicitly as Shopify's, so
--   this dedupes defensively the same way regardless).
--
-- Design notes
--   - `razorpay_stores.webhook_secret` is stored PLAINTEXT — NOT
--     `encrypt()`'d, unlike every other secret column in this schema
--     (`whatsapp_config.access_token`, `webhook_endpoints.secret`,
--     `shopify_stores.webhook_secret`). This is deliberate (confirmed
--     in chat) but flagged as a disagreement at the time: it's the
--     same class of secret as `webhook_endpoints.secret` (an
--     app-generated random token, not a third-party key) and that one
--     IS encrypted, so the "opaque token vs real key" distinction
--     doesn't hold up against this codebase's own precedent. Revisit
--     if this table's threat model changes.
--   - Unlike Shopify (HMAC over the raw body via a per-shop signing
--     secret), Razorpay's Magic Checkout abandoned-cart webhook signs
--     nothing — confirmed against Razorpay's docs, no signature or
--     secret mechanism exists for this specific webhook (their
--     general payment webhooks do sign, via X-Razorpay-Signature; this
--     feature doesn't). So `webhook_secret` here isn't a signing key
--     at all — it's a shared token WE generate, and the registered
--     webhook URL carries it as `?key=`; the route does an exact
--     timing-safe compare, not HMAC verification.
--   - `shop_id` is UNIQUE — mirrors `shopify_stores.shop_domain`.
--     Whether one wacrm account ever needs more than one Razorpay
--     store row is unconfirmed (Magic Checkout's dashboard setup
--     wasn't checked for a multi-store case) — schema doesn't prevent
--     it either way, same shape as Shopify's.
--   - Both tables are service-role only (no dashboard UI to manage
--     Razorpay store connections or browse the event log), mirroring
--     037/038.
--
-- Deliberately NOT included here: a `razorpay_scheduled_notifications`
-- table. Whether Razorpay's abandoned-cart webhook fires immediately
-- on cart creation (send-now, like Shopify's orders/create path) or
-- only after Razorpay's own abandonment delay (queue-and-drain, like
-- Shopify's checkouts/create → shopify_scheduled_notifications path)
-- is unconfirmed — see the webhook route's header comment. Add a
-- follow-up migration for that table only once it's confirmed a delay
-- queue is actually needed; don't speculatively build it now.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS razorpay_stores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop_id        text NOT NULL UNIQUE,   -- Razorpay's `shop_id` field in the webhook body
  webhook_secret text NOT NULL,          -- plaintext shared token — see Design notes above
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every webhook delivery looks the store up by shop_id (the UNIQUE
-- constraint already indexes it, but spelled out for the same reason
-- as shopify_stores_shop_domain_idx — documents the hot-path lookup).
CREATE INDEX IF NOT EXISTS razorpay_stores_shop_id_idx
  ON razorpay_stores (shop_id);
CREATE INDEX IF NOT EXISTS razorpay_stores_account_id_idx
  ON razorpay_stores (account_id);

ALTER TABLE razorpay_stores ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for `authenticated` yet —
-- store connections are provisioned server-side (service role) until
-- a Settings UI exists. Mirrors shopify_stores.

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text NOT NULL UNIQUE,   -- x-razorpay-event-id
  shop_id       text NOT NULL,
  status        text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'sent', 'scheduled', 'skipped', 'failed')),
  error_message text,                   -- skip/schedule reason or send failure detail
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS razorpay_webhook_events_status_idx
  ON razorpay_webhook_events (status, received_at DESC);

ALTER TABLE razorpay_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policy for `authenticated` — service-role only, same as above.
-- No retention/cleanup job yet — mirrors shopify_webhook_events' note
-- about pruning `received_at < now() - interval '90 days'` if volume
-- grows.
