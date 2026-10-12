// ============================================================
// Extraido de src/lib/ai/auto-reply.ts (comportamento idêntico,
// nenhuma mudança de lógica) pra o job de reconciliação de
// agendamento (src/lib/ai/meeting-reconciliation.ts) poder reusar
// sem duplicar.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePipelineAndStage } from '@/lib/api/v1/deals'

/**
 * Deals created via the public API (the Apify/Meta/site-form bridge --
 * see POST /api/v1/deals) only ever get `contact_id` set, never
 * `conversation_id`: the conversation itself is created separately,
 * whenever the contact's first WhatsApp message actually arrives, so
 * nothing links the two at creation time. Matching on
 * `conversation_id` alone would silently never find a deal for any
 * real lead, so this always resolves by contact -- `status = 'open'`
 * picks the live deal over an already won/lost one if the contact has
 * history. When `conversationId` is given and the found deal doesn't
 * have one yet, opportunistically backfills it.
 *
 * A contact who messages in WITHOUT going through that bridge --
 * someone texting the number directly, an organic/CTWA ad reply, a
 * manual test -- never gets a deal created ahead of time. If none
 * exists, one is created on the spot, in the account's default
 * pipeline/stage (`resolvePipelineAndStage` with no name args -- the
 * same default a deal created by hand in the dashboard would land in).
 *
 * Deliberately IGNORES `accounts.auto_create_deal_on_first_message`
 * (migration 079, default false for every account including Fuse's
 * own -- see `ensureDealForContact` in `lib/whatsapp/inbound-message.ts`,
 * which DOES respect that flag). That flag exists to stop a random
 * first WhatsApp message from silently spawning a deal; a lead who
 * got all the way to a scheduled meeting -- name, e-mail, a chosen
 * time -- is a wholly different signal than "sent one message", so
 * this path creates the deal regardless of the account's setting.
 * Confirmed with the product owner on 2026-10-12.
 */
export async function findOpenDealForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
  configOwnerUserId: string,
): Promise<{ id: string; pipeline_id: string; title: string } | null> {
  const { data: deal } = await db
    .from('deals')
    .select('id, pipeline_id, title, conversation_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (deal) {
    if (conversationId && !deal.conversation_id) {
      await db.from('deals').update({ conversation_id: conversationId }).eq('id', deal.id)
    }
    return deal
  }

  return createDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
}

/**
 * Creates the deal `findOpenDealForContact` didn't find. Best-effort:
 * any failure here (no pipeline configured yet, a race with another
 * concurrent creation, a transient DB error) returns null rather than
 * throwing -- callers must never fail because deal bookkeeping
 * couldn't complete.
 */
async function createDealForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
  configOwnerUserId: string,
): Promise<{ id: string; pipeline_id: string; title: string } | null> {
  try {
    const { pipelineId, stageId } = await resolvePipelineAndStage(db, accountId)

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const title = (contact?.name as string | undefined)?.trim() || (contact?.phone as string | undefined) || 'Lead sem nome'

    const { data: created, error } = await db
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        contact_id: contactId,
        conversation_id: conversationId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        title,
        // Same fallback value `ensureDealForContact` uses for an
        // organic/direct WhatsApp contact (migration 038's allowed-
        // values CHECK constraint, `isDealSource`) -- accurate here
        // too, since this path exists for exactly that kind of lead.
        source: 'WhatsApp Direto',
        status: 'open',
      })
      .select('id, pipeline_id, title')
      .single()
    if (error || !created) {
      console.error('[find-or-create-open-deal] createDealForContact insert failed:', error)
      return null
    }
    return created as { id: string; pipeline_id: string; title: string }
  } catch (err) {
    console.error('[find-or-create-open-deal] createDealForContact failed:', err)
    return null
  }
}
