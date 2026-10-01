import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'

// ============================================================
// POST /api/automations/test-send
//
// Backs the "Testar número de telefone" control in the automation
// builder (send_message / send_media steps) — same idea as
// ClickFunnels' test-send button: type a phone number, get exactly
// what this step would send, without needing a real trigger event.
//
// Finds-or-creates the contact + conversation for the given phone
// (same helper the public API uses for phone-only sends) and sends
// through the account's normal send path — so the test is a real,
// representative send, not a simulation.
// ============================================================

const SAMPLE_VARS: Record<string, string> = {
  nome: 'Fulana de Tal',
  primeiro_nome: 'Fulana',
  email: 'cliente@email.com',
  produto: 'Produto Exemplo',
  valor: '197',
  moeda: 'BRL',
  evento: 'PURCHASE_APPROVED',
}

/** Fills `{{ vars.x }}` tokens with readable sample data for a preview
 *  send — there's no real trigger context to pull from here. */
function interpolateSample(s: string, phone: string): string {
  return s.replace(/\{\{\s*vars\.(\w+)\s*\}\}/g, (_, key: string) => {
    if (key === 'telefone') return phone
    return SAMPLE_VARS[key] ?? ''
  })
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as {
      phone?: string
      step_type?: string
      step_config?: Record<string, unknown>
    } | null
    const phone = body?.phone?.trim()
    const stepType = body?.step_type
    const cfg = body?.step_config
    if (!phone || !stepType || !cfg) {
      return NextResponse.json(
        { error: "'phone', 'step_type' and 'step_config' are required" },
        { status: 400 },
      )
    }

    const resolved = await resolveConversationByPhone(supabase, accountId, phone)

    if (stepType === 'send_message') {
      const text = interpolateSample(String(cfg.text ?? ''), phone)
      if (!text.trim()) {
        return NextResponse.json({ error: 'Message text is empty' }, { status: 400 })
      }
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId: resolved.conversationId,
        messageType: 'text',
        contentText: text,
      })
      return NextResponse.json({ message_id: result.messageId })
    }

    if (stepType === 'send_media') {
      const mediaUrl = String(cfg.media_url ?? '')
      if (!mediaUrl) {
        return NextResponse.json({ error: 'No file uploaded on this step yet' }, { status: 400 })
      }
      const mediaType = cfg.media_type === 'audio' ? 'audio' : 'image'
      const caption = cfg.caption ? interpolateSample(String(cfg.caption), phone) : null
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId: resolved.conversationId,
        messageType: mediaType,
        mediaUrl,
        contentText: caption,
      })
      return NextResponse.json({ message_id: result.messageId })
    }

    return NextResponse.json(
      { error: `Test send isn't supported for step type '${stepType}'` },
      { status: 400 },
    )
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
