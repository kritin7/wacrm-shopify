-- ============================================================
-- 037_shopify_integration.sql — Shopify → WhatsApp order notifications
--
-- Two tables backing `POST /api/shopify/webhook`:
--
--   shopify_stores — maps a Shopify shop to the wacrm account that
--   should receive its order events, and holds the per-shop webhook
--   signing secret Shopify issues when you register a webhook
--   subscription (Admin API `webhookSubscriptionCreate`, or the
--   "Notifications" webhook settings page).
--
--   shopify_webhook_events — dedupe + outcome log for inbound
--   deliveries, keyed on Shopify's `X-Shopify-Webhook-Id` header.
--   Shopify retries on any non-2xx/timeout, and can also redeliver
--   the same event id after a network-level ambiguity, so every
--   delivery must be checked against this table before it's acted on.
--   Doubles as the "why didn't message X send" log the dashboard
--   doesn't have a UI for yet — query it directly (Supabase table
--   editor / SQL) instead of digging through Vercel function logs.
--
-- Design notes
--   - `shopify_stores.webhook_secret` is AES-256-GCM-encrypted at
--     rest via the same `encrypt()`/`decrypt()` helpers as
--     `whatsapp_config.access_token` and `webhook_endpoints.secret` —
--     we need the plaintext at verification time (to recompute the
--     HMAC over the raw request body), so hashing (like `api_keys`)
--     isn't an option here.
--   - `shop_domain` is UNIQUE — a Shopify shop routes to exactly one
--     wacrm account. `account_id` is NOT unique — one account may
--     receive events from more than one storefront.
--   - Both tables are service-role only for now (no dashboard UI
--     exists yet to manage Shopify store connections or browse the
--     event log), mirroring `automation_pending_executions` — RLS is
--     enabled with no policies for `authenticated`, so a future
--     Settings page can add scoped SELECT/INSERT policies without a
--     migration that has to retrofit RLS onto existing rows.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_stores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop_domain    text NOT NULL UNIQUE,   -- e.g. "my-shop.myshopify.com"
  webhook_secret text NOT NULL,          -- AES-256-GCM-encrypted (encrypt()/decrypt())
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every webhook delivery looks the store up by shop_domain (the
-- UNIQUE constraint already indexes it, but spelled out for the same
-- reason as api_keys_key_hash_idx — documents the hot-path lookup).
CREATE INDEX IF NOT EXISTS shopify_stores_shop_domain_idx
  ON shopify_stores (shop_domain);
CREATE INDEX IF NOT EXISTS shopify_stores_account_id_idx
  ON shopify_stores (account_id);

ALTER TABLE shopify_stores ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for `authenticated` yet —
-- store connections are provisioned server-side (service role) until
-- a Settings UI exists. Mirrors automation_pending_executions.

CREATE TABLE IF NOT EXISTS shopify_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text NOT NULL UNIQUE,   -- X-Shopify-Webhook-Id
  shop_domain   text NOT NULL,
  topic         text NOT NULL,          -- X-Shopify-Topic, e.g. "orders/create"
  status        text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'sent', 'scheduled', 'skipped', 'failed')),
  error_message text,                   -- skip/schedule reason or send failure detail
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- The dedupe check on every delivery is a lookup/insert on event_id
-- (UNIQUE already indexes it). status is indexed separately since the
-- "show me what failed" query filters on it directly.
CREATE INDEX IF NOT EXISTS shopify_webhook_events_status_idx
  ON shopify_webhook_events (status, received_at DESC);

ALTER TABLE shopify_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policy for `authenticated` — service-role only, same as above.
-- No retention/cleanup job yet; if event volume gets large, prune
-- `received_at < now() - interval '90 days'` (or add a cron, mirroring
-- the automation_pending_executions drain pattern).
