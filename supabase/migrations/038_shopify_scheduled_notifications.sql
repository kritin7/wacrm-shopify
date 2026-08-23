-- ============================================================
-- 038_shopify_scheduled_notifications.sql — delayed Shopify nudges
--
-- `abandoned_cart` and `cod_followup` aren't triggered by a single
-- Shopify webhook — they're "wait N, then send unless something else
-- happened first" — so they don't fit the direct
-- webhook-in/template-out path `shopify_webhook_events` covers. This
-- table is their queue, drained by `GET /api/cron/shopify-notifications`
-- on a schedule, same shape as `automation_pending_executions` +
-- `/api/automations/cron`.
--
-- Lifecycle
--   pending   — scheduled, not yet due.
--   running   — claimed by a cron invocation (same claim-then-process
--               lock as automation_pending_executions; see the cron
--               route for why a plain conditional UPDATE is enough).
--   sent      — delivered.
--   cancelled — superseded before it fired:
--                 abandoned_cart cancelled when the same checkout_token
--                 shows up on an orders/create (the cart converted);
--                 cod_followup cancelled when the same order_id gets a
--                 fulfillments/create (it shipped — no need to nudge).
--   skipped   — became un-sendable at drain time (e.g. phone invalid).
--   failed    — send attempted and failed; see error_message.
--
-- `UNIQUE (kind, reference_id)` — a redelivered checkouts/create (or
-- a second orders/create-COD, which shouldn't happen but webhooks are
-- at-least-once) can't schedule the same nudge twice; the webhook
-- route treats the resulting unique-violation as a no-op.
--
-- Body values and the target phone are computed once at schedule time
-- (not re-derived at drain time) — the source webhook payload isn't
-- kept around, so `phone`/`contact_name`/`body` are the only record
-- of who this was for and what to say.
--
-- Service-role only (no dashboard UI yet) — mirrors
-- automation_pending_executions and the 037 tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_scheduled_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shop_domain   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('abandoned_cart', 'cod_followup')),
  -- checkout_token for abandoned_cart; Shopify order id (as text) for cod_followup.
  reference_id  text NOT NULL,
  phone         text NOT NULL,   -- already E.164-normalized at schedule time
  contact_name  text,
  template_name text NOT NULL,
  language      text NOT NULL DEFAULT 'en',
  body          jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'sent', 'cancelled', 'skipped', 'failed')),
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference_id)
);

-- Cron drain query: due + pending, oldest first.
CREATE INDEX IF NOT EXISTS shopify_scheduled_notifications_due_idx
  ON shopify_scheduled_notifications (run_at) WHERE status = 'pending';
-- Cancellation UPDATEs (from the webhook route) look up by exactly
-- this pair; UNIQUE already indexes it, spelled out for the same
-- documentation reason as the 026/028 hot-path indexes.
CREATE INDEX IF NOT EXISTS shopify_scheduled_notifications_kind_ref_idx
  ON shopify_scheduled_notifications (kind, reference_id);

ALTER TABLE shopify_scheduled_notifications ENABLE ROW LEVEL SECURITY;
-- No policy for `authenticated` — service-role only, same as 037.
