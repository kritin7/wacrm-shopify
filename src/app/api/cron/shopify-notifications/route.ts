import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'

/**
 * Drain due `shopify_scheduled_notifications` rows — the abandoned_cart
 * and cod_followup reminders scheduled by `/api/shopify/webhook`
 * (`checkouts/create` and COD `orders/create` respectively), which are
 * "wait N, then send unless cancelled" rather than a direct
 * single-webhook trigger.
 *
 * Same shared-secret auth (`AUTOMATION_CRON_SECRET` — re-used so
 * operators don't provision a fourth cron secret alongside
 * `/api/automations/cron` and `/api/flows/cron`) and claim-then-process
 * pattern as `/api/automations/cron`: an `UPDATE ... WHERE status =
 * 'pending'` that only one concurrent invocation can win serves as the
 * lock, avoided a real `SELECT ... FOR UPDATE`.
 *
 * Hosting: hit on a schedule (Vercel Cron / external pinger) — same as
 * the other two cron routes. A 15–30 minute interval is more than
 * enough given the hour/day-scale delays these rows carry.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const { data: due, error } = await db
    .from('shopify_scheduled_notifications')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[shopify-cron] fetch failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await db
      .from('shopify_scheduled_notifications')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue // lost the race to another invocation
    processed++

    try {
      const resolved = await resolveConversationByPhone(
        db,
        row.account_id as string,
        row.phone as string,
        (row.contact_name as string | null) ?? undefined,
      )
      const result = await sendMessageToConversation(db, row.account_id as string, {
        conversationId: resolved.conversationId,
        messageType: 'template',
        templateName: row.template_name as string,
        templateLanguage: (row.language as string | null) ?? 'en',
        templateMessageParams: { body: (row.body as string[]) ?? [] },
      })
      await db
        .from('shopify_scheduled_notifications')
        .update({ status: 'sent', error_message: `wamid ${result.whatsappMessageId}` })
        .eq('id', row.id)
    } catch (err) {
      const message =
        err instanceof SendMessageError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)
      console.error('[shopify-cron] send failed:', { id: row.id, kind: row.kind, message })
      await db
        .from('shopify_scheduled_notifications')
        .update({ status: 'failed', error_message: message })
        .eq('id', row.id)
    }
  }

  return NextResponse.json({ processed })
}
