import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isValidAsaasWebhookToken } from '@/lib/asaas/webhook-auth'
import { getAsaasCustomer } from '@/lib/asaas/client'
import { resolvePlanLabel, FUSE_ACCOUNT_ID, FUSE_SALES_WHATSAPP_CHANNEL_ID } from '@/lib/asaas/fuse-sales-config'
import { generateSignupToken } from '@/lib/auth/signup-invitations'
import { resolveChannelById } from '@/lib/whatsapp/resolve-channel'
import { createUazapiProvider } from '@/lib/whatsapp/uazapi-provider'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// Asaas payment events that mean "money actually landed" — see
// docs.asaas.com/docs/webhook-para-cobrancas.
const RELEVANT_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])
const SIGNUP_LINK_EXPIRES_DAYS = 14

/**
 * POST /api/webhooks/asaas
 *
 * Closes the loop opened by migration 068: when a customer pays one
 * of Fuse's own recurring subscription links (Plano FuseHub / Growth /
 * Performance), auto-generate a single-use signup_invitations token
 * and send it straight to the customer's WhatsApp — no manual step.
 *
 * Fuse-internal automation, not a per-tenant feature (see
 * fuse-sales-config.ts) — this endpoint only ever provisions access to
 * Fuse's OWN product for Fuse's OWN paying customers, so hardcoding
 * Fuse's account/channel ids here is intentional, not a violation of
 * the "no hardcoded tenant behavior" rule.
 *
 * Ack fast, process after — same rationale as the inbound-webhook and
 * Meta/UAZAPI webhook routes: Asaas retries on a non-200 response and
 * can pause the whole webhook queue after 15 consecutive failures.
 */
export async function POST(request: Request) {
  const token = request.headers.get('asaas-access-token')
  if (!isValidAsaasWebhookToken(token)) {
    console.warn('[asaas-webhook] rejected request with invalid/missing auth token')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processAsaasEvent(body)
    } catch (err) {
      console.error('[asaas-webhook] error processing event:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

interface AsaasWebhookPayload {
  event?: string
  payment?: {
    id?: string
    customer?: string
    subscription?: string
    value?: number
  }
}

async function processAsaasEvent(rawBody: unknown) {
  const body = rawBody as AsaasWebhookPayload
  const event = body?.event
  const payment = body?.payment

  if (!event || !RELEVANT_EVENTS.has(event) || !payment?.customer) {
    return
  }

  const subscriptionId = payment.subscription
  if (!subscriptionId) {
    // A one-time (non-subscription) charge — outside the scope of this
    // automation; all 3 sales links are RECURRENT.
    console.warn('[asaas-webhook] payment with no subscription id, ignoring:', payment.id)
    return
  }

  const admin = supabaseAdmin()
  const planLabel = resolvePlanLabel(payment.value ?? 0)

  // Atomically claim this subscription. First payment wins the insert;
  // every renewal's PAYMENT_CONFIRMED — and any retried delivery of
  // the same first-payment event, since Asaas uses "at least once"
  // delivery — hits the unique constraint and is a silent no-op.
  const { error: insertError } = await admin.from('asaas_processed_subscriptions').insert({
    subscription_id: subscriptionId,
    customer_id: payment.customer,
    payment_id: payment.id ?? null,
    plan_label: planLabel,
  })

  if (insertError) {
    if (insertError.code === '23505') {
      return
    }
    throw insertError
  }

  const customer = await getAsaasCustomer(payment.customer)
  const rawPhone = customer.mobilePhone || customer.phone
  if (!rawPhone) {
    console.error('[asaas-webhook] customer has no phone on file:', payment.customer)
    return
  }
  const phone = normalizePhone(`55${rawPhone}`)

  const { plaintext, hash } = generateSignupToken()
  const expiresAt = new Date(
    Date.now() + SIGNUP_LINK_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { error: signupInsertError } = await admin.from('signup_invitations').insert({
    token_hash: hash,
    label: `Asaas • ${planLabel} • ${customer.name}`,
    expires_at: expiresAt,
  })

  if (signupInsertError) {
    throw signupInsertError
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://fusehub.fusegrowth.com.br'
  const signupUrl = `${appUrl}/signup?signup_token=${plaintext}`

  const channel = await resolveChannelById(admin, FUSE_ACCOUNT_ID, FUSE_SALES_WHATSAPP_CHANNEL_ID)
  if (!channel) {
    console.error('[asaas-webhook] Fuse sales WhatsApp channel not found/misconfigured')
    return
  }

  const firstName = (customer.name || '').trim().split(/\s+/)[0]
  const greeting = firstName ? `Olá, ${firstName}!` : 'Olá!'
  const text = [
    `${greeting} 🎉`,
    '',
    `Seu pagamento do ${planLabel} foi confirmado.`,
    '',
    'Pra criar seu acesso ao FuseHub, é só abrir o link abaixo e definir sua senha:',
    signupUrl,
  ].join('\n')

  const provider = createUazapiProvider(channel)
  await provider.sendText({ to: phone, text })
}
