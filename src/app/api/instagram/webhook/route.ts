// src/app/api/instagram/webhook/route.ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { findOrCreateInstagramContact } from '@/lib/contacts/instagram-dedupe'
import { fetchInstagramUsername } from '@/lib/instagram/graph-api'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

// See docs/superpowers/specs/2026-09-24-instagram-integration-design.md.
// Payload shapes below follow Meta's documented Instagram Messaging
// webhook format (comments mirror the Graph API "comments" field;
// messaging mirrors the Messenger Platform shape Instagram DMs reuse)
// — like the UAZAPI webhook's own payload comments in this codebase,
// this is best-effort until confirmed against a live delivery.

export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface CommentChangeValue {
  from?: { id: string; username?: string }
  id: string
  text?: string
}

interface MessagingEvent {
  sender?: { id: string }
  message?: { mid: string; text?: string }
}

interface InstagramWebhookEntry {
  id: string
  changes?: Array<{ field: string; value: CommentChangeValue }>
  messaging?: MessagingEvent[]
}

interface InstagramWebhookBody {
  object?: string
  entry?: InstagramWebhookEntry[]
}

// GET - Meta's one-time subscription verification.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  if (mode !== 'subscribe' || !challenge) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST - Receive comment/DM events.
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram/webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: InstagramWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack Meta immediately (same reasoning as the WhatsApp webhook's
  // after() usage) — real processing happens after the response is
  // sent, but the runtime is kept alive until it finishes.
  const runProcessing = async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[instagram/webhook] processing failed:', error)
    }
  }
  try {
    after(runProcessing)
  } catch {
    // `after()` throws when called outside a request scope (e.g. unit
    // tests invoking the route handler directly rather than through
    // Next's request pipeline). Fall back to plain fire-and-forget so
    // behaviour outside that pipeline still runs the same code path.
    void runProcessing()
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: InstagramWebhookBody) {
  if (!body.entry) return
  const db = supabaseAdmin()

  for (const entry of body.entry) {
    const igUserId = entry.id

    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue
      await handleEvent(db, {
        igUserId,
        igsid: change.value.from?.id,
        eventKey: `comment:${change.value.id}`,
        text: change.value.text ?? '',
        triggerType: 'instagram_comment_received',
      })
    }

    for (const messagingEvent of entry.messaging ?? []) {
      if (!messagingEvent.message?.mid) continue
      await handleEvent(db, {
        igUserId,
        igsid: messagingEvent.sender?.id,
        eventKey: `dm:${messagingEvent.message.mid}`,
        text: messagingEvent.message.text ?? '',
        triggerType: 'instagram_dm_received',
      })
    }
  }
}

async function handleEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    igUserId: string
    igsid: string | undefined
    eventKey: string
    text: string
    triggerType: 'instagram_comment_received' | 'instagram_dm_received'
  },
) {
  if (!args.igsid) return

  // Dedupe first — Meta redelivers "at least once". A unique-violation
  // on insert means this exact event was already handled.
  const { error: dedupeError } = await db
    .from('instagram_webhook_events')
    .insert({ event_key: args.eventKey })
  if (dedupeError) {
    if (dedupeError.code === '23505') return // already processed
    console.error('[instagram/webhook] dedupe insert failed:', dedupeError)
    return
  }

  const { data: config } = await db
    .from('instagram_config')
    .select('account_id, access_token')
    .eq('ig_user_id', args.igUserId)
    .maybeSingle()
  if (!config) {
    console.warn('[instagram/webhook] no instagram_config for ig_user_id', args.igUserId)
    return
  }

  const pageAccessToken = decrypt(config.access_token)
  const username = await fetchInstagramUsername({ igsid: args.igsid, pageAccessToken }).catch(
    () => null,
  )

  const { id: contactId } = await findOrCreateInstagramContact(db, config.account_id, {
    igsid: args.igsid,
    username,
  })

  await runAutomationsForTrigger({
    accountId: config.account_id,
    triggerType: args.triggerType,
    contactId,
    context: { message_text: args.text },
  })
}
