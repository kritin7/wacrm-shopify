-- ============================================================
-- 041_shopify_order_cache.sql — local order-facts cache for
-- fulfillments/update and refunds/create
--
-- Why this exists:
--   Two Shopify webhook payloads this route handles don't carry
--   enough to build their WhatsApp templates on their own:
--
--     - fulfillments/update (out_for_delivery branch): the Fulfillment
--       resource has no financial_status/gateway/payment_gateway_names
--       at all (confirmed against Shopify's own REST resource docs —
--       it's a shipping resource, not a payment one), so there's no
--       way to pick out_for_delivery_prepaid vs out_for_delivery_cod
--       from the event itself. Previously always skipped for exactly
--       this reason (see route.ts).
--     - refunds/create: the Refund payload carries `order_id` only —
--       no customer, shipping_address, or phone. Previously always
--       skipped (see route.ts).
--
--   Re-fetching the order from Shopify's Admin API per event was the
--   alternative (an external HTTP round-trip + rate-limit exposure on
--   the hot webhook path); instead, `handleOrderCreate` snapshots the
--   fields these two handlers need into this table once, at order
--   creation — a local cache, not a live-syncing order mirror. If an
--   order's financial_status/payment method changes after creation via
--   some other Shopify event, this cache goes stale — accepted, since
--   this route doesn't subscribe to orders/updated and the cached
--   fields only ever drive template *selection*/display, not
--   billing-critical logic.
--
-- Miss handling (deliberate, not this table's problem to solve):
--   No row for an order_id — because the order predates this cache,
--   or its orders/create webhook failed/was missed — means the two
--   handlers above skip-and-log with a specific reason rather than
--   guessing prepaid/cod or fabricating contact info. See route.ts.
--
-- Expiry/cleanup: none, deliberately. Order volume here is nowhere
-- near a real storage concern (rows are a handful of short text
-- fields + a bool), and unlike shopify_webhook_events (an audit log
-- that grows once per webhook DELIVERY, including retries), this
-- table grows once per Shopify ORDER — a materially smaller rate.
-- Revisit only if that assumption stops holding.
--
-- `order_id` is UNIQUE (not scoped by account/shop) — Shopify order
-- ids are unique across the whole platform, not just per-shop, so a
-- global unique constraint is correct and simpler than a compound key
-- (mirrors the reasoning already used for shopify_stores.shop_id).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_order_cache (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop_domain          text NOT NULL,
  -- Shopify's numeric order id, as text — matches how order ids are
  -- already handled elsewhere in this schema (shopify_scheduled_notifications.reference_id).
  order_id             text NOT NULL UNIQUE,
  -- order.name ?? String(order.id) — the same fallback handleOrderCreate
  -- already applies for its own send, precomputed so readers don't
  -- have to re-derive it.
  order_name           text NOT NULL,
  -- formatOrderAmount(order.total_price) — same value/formatting used
  -- for order_placed_prepaid's prepaid_order_amount /
  -- order_placed_cod's cod_order_amount; reused as-is for
  -- out_for_delivery_cod's cod_amount and refund_prepaid's
  -- prepaid_order_amount. Empty string (not NULL) when Shopify sent no
  -- total_price, matching formatOrderAmount's own contract.
  order_amount         text NOT NULL DEFAULT '',
  -- guessIsPrepaid(order) at orders/create time — see route.ts for the
  -- heuristic and its own documented caveats/TODOs. A snapshot of a
  -- guess, not a fact Shopify asserts.
  is_prepaid           boolean NOT NULL,
  -- Already defaulted to 'there' if the order carried no name, same
  -- as handleOrderCreate's own send — readers get a ready-to-use value.
  customer_first_name  text NOT NULL DEFAULT 'there',
  -- E.164-normalized (normalizeShopifyPhone) at write time, using
  -- whatever country_code was available on the order payload then.
  -- NULL when the order's phone couldn't be normalized to a valid
  -- number — readers MUST handle this (skip-and-log), not assume
  -- non-null.
  customer_phone       text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_order_cache_account_id_idx
  ON shopify_order_cache (account_id);

ALTER TABLE shopify_order_cache ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for `authenticated` — written
-- and read exclusively by this webhook route (service role), same
-- posture as shopify_stores / shopify_webhook_events / shopify_scheduled_notifications.
