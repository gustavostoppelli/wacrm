import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolvePipelineAndStage, DealError } from '@/lib/api/v1/deals'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// ============================================================
// POST /api/deals/create-from-contact
//
// Backs the Inbox's "Criar negócio" button — an explicit, one-click
// alternative to ensureDealForContact's automatic first-message deal
// (src/lib/whatsapp/inbound-message.ts), which an account can now turn
// off per-account (migration 079) to avoid duplicate/junk deals from
// WhatsApp spam. This route always works regardless of that flag: it's
// the deliberate "yes, make this conversation a lead" action.
//
// Idempotent: if the contact already has an open deal, returns it
// instead of creating a second one (the exact duplication this button
// exists to avoid).
// ============================================================

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as {
      contact_id?: string
      conversation_id?: string
    } | null
    const contactId = body?.contact_id
    if (!contactId) {
      return NextResponse.json({ error: "'contact_id' is required" }, { status: 400 })
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('id, name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { data: existing } = await supabase
      .from('deals')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .limit(1)
      .maybeSingle()
    if (existing) {
      return NextResponse.json({ deal_id: existing.id, already_existed: true })
    }

    let pipelineId: string
    let stageId: string
    try {
      ;({ pipelineId, stageId } = await resolvePipelineAndStage(supabase, accountId))
    } catch (err) {
      if (err instanceof DealError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const { data: account } = await supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()

    const title = contact.name || contact.phone

    const { data: deal, error } = await supabase
      .from('deals')
      .insert({
        user_id: userId,
        account_id: accountId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        conversation_id: body?.conversation_id ?? null,
        title,
        value: 0,
        currency: account?.default_currency ?? null,
        source: 'WhatsApp Direto',
        status: 'open',
      })
      .select('id')
      .single()
    if (error || !deal) {
      return NextResponse.json({ error: 'Failed to create deal' }, { status: 500 })
    }

    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'deal.created', {
      deal_id: deal.id,
      title,
      source: 'WhatsApp Direto',
      contact: { id: contact.id, name: contact.name, phone: contact.phone },
    })

    return NextResponse.json({ deal_id: deal.id, already_existed: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
