-- ============================================================
-- 039_template_parameter_format.sql — track NAMED vs POSITIONAL
--
-- Meta templates come in two variable-substitution conventions:
--   POSITIONAL — {{1}}, {{2}}, … filled in array order (the only
--                shape wacrm understood until now).
--   NAMED      — {{first_name}}, {{order_number}}, … filled in by
--                name; the send payload must carry `parameter_name`
--                on each text parameter instead of relying on order.
--
-- Every real (non-hello_world) template in this account's WABA uses
-- NAMED — it's the primary case, not an edge case. The sync route
-- now fetches `parameter_format` from Meta and needs somewhere to
-- persist it so the send builder (template-send-builder.ts) can
-- branch on it per template.
--
-- Default 'POSITIONAL' matches Meta's own default for templates
-- created before NAMED existed, and keeps existing rows (synced
-- before this column existed) behaving exactly as before until the
-- next sync backfills the real value.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS parameter_format TEXT NOT NULL DEFAULT 'POSITIONAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'message_templates_parameter_format_check'
      AND conrelid = 'message_templates'::regclass
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_parameter_format_check
      CHECK (parameter_format IN ('POSITIONAL', 'NAMED'));
  END IF;
END $$;
