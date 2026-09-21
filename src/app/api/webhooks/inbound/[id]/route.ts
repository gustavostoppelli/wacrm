import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { hashInboundWebhookToken, timingSafeHexEqual } from '@/lib/webhooks/inbound-tokens'
import { parseInboundWebhookPayload } from '@/lib/webhooks/inbound-parse'

/**
 * POST /api/webhooks/inbound/[id]?token=<plaintext>
 *
 * Public receiving endpoint for an account's own inbound webhook
 * connection (Settings → Integrações, migration 066) — the URL an
 * external tool (a checkout platform, a form, anything that can POST
 * JSON) is configured to call. No signed-in user; `token` is the
 * connection's bearer credential, checked against the stored hash the
 * same way an API key is (see api-keys/keys.ts).
 *
 * Ack fast, process after — same rationale as the Meta/UAZAPI webhook
 * routes: the sender may retry on a slow response, and serverless
 * functions can be frozen the instant the response is sent.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const token = new URL(request.url).searchParams.get('token') ?? ''
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: webhook, error } = await admin
    .from('inbound_webhooks')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !webhook || !timingSafeHexEqual(hashInboundWebhookToken(token), webhook.token_hash)) {
    console.warn('[inbound-webhook] rejected request with invalid id/token')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!webhook.is_active) {
    return NextResponse.json({ error: 'Connection disabled' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processInboundWebhook(webhook, body)
    } catch (err) {
      console.error('[inbound-webhook] error processing event:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processInboundWebhook(webhook: any, rawBody: unknown) {
  const admin = supabaseAdmin()
  const parsed = parseInboundWebhookPayload(rawBody)

  admin
    .from('inbound_webhooks')
    .update({ last_received_at: new Date().toISOString() })
    .eq('id', webhook.id)
    .then(
      () => {},
      () => {},
    )

  let contactId: string | null = null

  if (parsed.contactPhone) {
    const phone = normalizePhone(parsed.contactPhone)
    let contact = await findExistingContact(admin, webhook.account_id, phone)

    if (!contact) {
      const { data: newContact, error: createError } = await admin
        .from('contacts')
        .insert({
          account_id: webhook.account_id,
          user_id: webhook.user_id,
          phone,
          name: parsed.contactName || phone,
          email: parsed.contactEmail || null,
        })
        .select()
        .single()

      if (createError) {
        if (isUniqueViolation(createError)) {
          contact = await findExistingContact(admin, webhook.account_id, phone)
        } else {
          console.error('[inbound-webhook] error creating contact:', createError)
        }
      } else {
        contact = newContact
      }
    } else if (parsed.contactName && parsed.contactName !== contact.name) {
      await admin
        .from('contacts')
        .update({ name: parsed.contactName, updated_at: new Date().toISOString() })
        .eq('id', contact.id)
    }

    if (contact) {
      contactId = contact.id as string

      if (parsed.action === 'open') {
        const { data: existingOpen } = await admin
          .from('deals')
          .select('id')
          .eq('account_id', webhook.account_id)
          .eq('contact_id', contactId)
          .eq('status', 'open')
          .limit(1)
          .maybeSingle()

        if (!existingOpen) {
          await admin.from('deals').insert({
            account_id: webhook.account_id,
            user_id: webhook.user_id,
            pipeline_id: webhook.pipeline_id,
            stage_id: webhook.stage_id,
            contact_id: contactId,
            title: parsed.dealTitle || parsed.contactName || phone,
            value: parsed.dealValue ?? 0,
            currency: parsed.dealCurrency || null,
            source: webhook.name,
            campaign: parsed.campaign,
            status: 'open',
          })
        }
      } else if (parsed.action === 'lost') {
        await admin
          .from('deals')
          .update({ status: 'lost' })
          .eq('account_id', webhook.account_id)
          .eq('contact_id', contactId)
          .eq('status', 'open')
      }
    }
  }

  // Fires regardless of whether a contact/deal was touched — an
  // account may just want to react to the raw event (e.g. an internal
  // Slack-style notification) without any CRM record involved.
  await runAutomationsForTrigger({
    accountId: webhook.account_id,
    triggerType: 'webhook_received',
    contactId,
    context: {
      webhook_id: webhook.id,
      vars: parsed.vars,
    },
  })
}
