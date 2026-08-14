import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { processInboundMessage } from '@/lib/whatsapp/inbound-message'
import type { ContentType } from '@/types'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * UAZAPI's inbound message shape (see `uazapi-openapi-spec.yaml`'s
 * `Message` schema). Unlike Meta's Cloud API, `messageType` is closer
 * to the underlying whatsmeow/Baileys protocol type strings than a
 * clean enum — the mapping below is best-effort and SHOULD be
 * validated against a live UAZAPI webhook payload before relying on it
 * in production. Known gap for this phase: reaction and interactive-
 * button-tap parity are not implemented (UAZAPI's `reaction` field is
 * a bare id, not the {emoji, target} shape Meta sends).
 */
interface UazapiMessage {
  messageid?: string
  id?: string
  chatid?: string
  /** WhatsApp's privacy "linked ID" (`<digits>@lid`) — NOT a phone
   *  number. Never parse this as one; use `sender_pn` instead. */
  sender?: string
  /** The actual phone number, as `<digits>@s.whatsapp.net`. This is
   *  what `sender` looked like before WhatsApp's LID rollout — real
   *  UAZAPI payloads (confirmed 2026-08-14) send both. */
  sender_pn?: string
  senderName?: string
  fromMe?: boolean
  isGroup?: boolean
  messageType?: string
  text?: string
  content?: unknown
  fileURL?: string
  quoted?: string
  messageTimestamp?: number
}

interface UazapiWebhookEvent {
  /** Confirmed real field name (2026-08-14) — UAZAPI does not send a
   *  lowercase `event` key despite what earlier docs/comments assumed. */
  EventType?: string
  instanceName?: string
  /** The message is a top-level sibling of `EventType`/`instanceName`,
   *  not nested under a `data` wrapper — despite what earlier
   *  docs/comments assumed. */
  message?: UazapiMessage
}

function mapContentType(messageType: string | undefined, hasFile: boolean): ContentType {
  if (!hasFile) return 'text'
  const t = (messageType || '').toLowerCase()
  if (t.includes('image') || t.includes('sticker')) return 'image'
  if (t.includes('video')) return 'video'
  if (t.includes('audio') || t.includes('ptt')) return 'audio'
  return 'document'
}

// POST — receive inbound events. No signature scheme is documented for
// UAZAPI webhooks (unlike Meta's HMAC), so the `ch` + `key` query params
// registered on the webhook URL (see `/api/uazapi/channels/[id]/connect`)
// are the tamper-resistance backstop — see migration 037's
// `uazapi_webhook_secret` column.
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const channelId = searchParams.get('ch')
  const key = searchParams.get('key')

  if (!channelId || !key) {
    return NextResponse.json({ error: 'Missing ch/key query params' }, { status: 400 })
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('id', channelId)
    .eq('provider', 'uazapi')
    .maybeSingle()

  if (configError || !config || config.uazapi_webhook_secret !== key) {
    console.warn('[uazapi-webhook] rejected request with invalid ch/key')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: UazapiWebhookEvent
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack fast, process after — same rationale as the Meta webhook (see
  // its route for the full explanation of why `after()` and not a
  // detached promise): serverless functions can be frozen the instant
  // the response is sent, so a floating promise's DB writes aren't
  // guaranteed to finish.
  after(async () => {
    try {
      await processWebhookEvent(body, config)
    } catch (error) {
      console.error('[uazapi-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processWebhookEvent(body: UazapiWebhookEvent, config: any) {
  if (body.EventType !== 'messages') return

  const message = body.message
  if (!message) return

  // We only send messages ourselves through the provider layer, never
  // through this webhook — `excludeMessages: ['wasSentByApi']` is set
  // at registration time (see uazapi-api.ts's registerWebhook), and
  // `fromMe` is a belt-and-braces guard against echoing our own sends
  // (e.g. a message sent manually from the connected phone).
  if (message.fromMe) return

  // Skip group messages entirely — never create a contact/conversation
  // for them. `isGroup` is UAZAPI's own flag; the `chatid` suffix is a
  // second, protocol-level check (group chat ids end `@g.us`, direct
  // chats end `@s.whatsapp.net`) so this still holds even if `isGroup`
  // is ever missing or wrong on a given payload.
  if (message.isGroup || message.chatid?.endsWith('@g.us')) return

  // `sender` is a `<digits>@lid` privacy ID, not a phone number, since
  // WhatsApp's LID rollout — `sender_pn` (`<digits>@s.whatsapp.net`) is
  // the real number and must be preferred. Confirmed against a live
  // payload 2026-08-14; falling back to `sender` only covers UAZAPI
  // deployments/protocol states that predate LIDs.
  const rawSender = message.sender_pn || message.sender
  if (!rawSender) return
  const senderPhone = normalizePhone(rawSender.split('@')[0])

  const externalMessageId = message.messageid || message.id
  if (!externalMessageId) return

  const hasFile = !!message.fileURL
  const contentType = mapContentType(message.messageType, hasFile)
  const contentText =
    typeof message.content === 'string' ? message.content : message.text || null

  await processInboundMessage({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    channelId: config.id,
    senderPhone,
    senderName: message.senderName || senderPhone,
    externalMessageId,
    timestamp: message.messageTimestamp ? new Date(message.messageTimestamp) : new Date(),
    contentType,
    contentText,
    mediaUrl: hasFile ? message.fileURL! : null,
    interactiveReplyId: null,
    replyToExternalMessageId: message.quoted || null,
    reaction: null,
  })
}
