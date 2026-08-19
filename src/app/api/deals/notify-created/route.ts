import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// ============================================================
// Dashboard-only notifier for `deal.created` webhook subscribers.
//
// The manual "New deal" form (src/components/pipelines/deal-form.tsx)
// inserts straight into `deals` via the browser's RLS-scoped Supabase
// client -- there's no server round-trip to hook a webhook dispatch
// into, unlike the WhatsApp-inbound path (ensureDealForContact) or the
// public /api/v1/deals bridge. This route is that missing hook: the
// form calls it, best-effort, right after a successful manual create.
//
// Not used for deals created via /api/v1/deals (site form, Meta Lead
// Ads sync, Apify) -- those callers already recorded the lead
// themselves (a spreadsheet row, etc.) before calling the API, so
// firing this for them would double it up.
// ============================================================

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { deal_id?: string } | null
    const dealId = body?.deal_id
    if (!dealId) {
      return NextResponse.json({ error: "'deal_id' is required" }, { status: 400 })
    }

    // RLS-scoped read confirms this deal actually belongs to the
    // caller's account before we act on it with the admin client below.
    const { data: deal } = await supabase
      .from('deals')
      .select('id, title, value, source, campaign, contact:contacts(id, name, phone, email)')
      .eq('id', dealId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (!deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 })
    }

    const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact

    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'deal.created', {
      deal_id: deal.id,
      title: deal.title,
      value: deal.value,
      source: deal.source,
      campaign: deal.campaign,
      contact: contact
        ? { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email }
        : null,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
