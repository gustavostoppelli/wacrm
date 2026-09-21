import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { generateInboundWebhookToken } from '@/lib/webhooks/inbound-tokens'

/**
 * GET /api/account/webhooks
 *
 * Lists this account's inbound webhook connections (Settings →
 * Integrações). Never returns token_hash — the plaintext token was
 * only ever shown once, at creation time (see POST below).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const { data, error } = await supabase
      .from('inbound_webhooks')
      .select('id, name, pipeline_id, stage_id, is_active, last_received_at, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to load webhook connections' }, { status: 500 })
    }
    return NextResponse.json({ webhooks: data ?? [] })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/account/webhooks
 *
 * Creates a new inbound webhook connection. Admin-only (settings-
 * class write, matches the RLS policy). Returns the plaintext token
 * and the ready-to-paste URL exactly once — the caller must show it
 * to the admin immediately, since it can never be retrieved again.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const body = await request.json()
    const { name, pipeline_id, stage_id } = body as {
      name?: string
      pipeline_id?: string
      stage_id?: string
    }
    if (!name?.trim() || !pipeline_id || !stage_id) {
      return NextResponse.json(
        { error: 'name, pipeline_id and stage_id are required' },
        { status: 400 },
      )
    }

    // Belt-and-braces: confirm the stage actually belongs to the named
    // pipeline (a stray id from a stale form shouldn't silently attach
    // to whatever stage that id resolves to under RLS).
    const { data: stage, error: stageError } = await supabase
      .from('pipeline_stages')
      .select('id, pipeline_id')
      .eq('id', stage_id)
      .eq('pipeline_id', pipeline_id)
      .maybeSingle()
    if (stageError || !stage) {
      return NextResponse.json({ error: 'Invalid pipeline_id/stage_id' }, { status: 400 })
    }

    const { plaintext, hash } = generateInboundWebhookToken()

    const { data: created, error } = await supabase
      .from('inbound_webhooks')
      .insert({
        account_id: accountId,
        created_by: userId,
        user_id: userId,
        name: name.trim(),
        token_hash: hash,
        pipeline_id,
        stage_id,
      })
      .select('id')
      .single()

    if (error || !created) {
      return NextResponse.json({ error: 'Failed to create webhook connection' }, { status: 500 })
    }

    const url = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/webhooks/inbound/${created.id}?token=${plaintext}`

    return NextResponse.json({ id: created.id, url, token: plaintext })
  } catch (error) {
    return toErrorResponse(error)
  }
}
