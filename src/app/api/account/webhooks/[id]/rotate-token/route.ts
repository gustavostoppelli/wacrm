import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { generateInboundWebhookToken } from '@/lib/webhooks/inbound-tokens'

/**
 * POST /api/account/webhooks/[id]/rotate-token
 *
 * Admin-only. Issues a NEW token for an existing inbound webhook
 * connection and returns the connection's full URL (with the plaintext
 * token) exactly once. The stored hash is replaced, so the previous URL
 * stops working immediately.
 *
 * Why it exists: the URL is only ever shown when the connection is
 * created (the DB keeps just the token's hash). If it was pasted into the
 * external tool wrong — or lost — the only way out used to be deleting
 * the connection and recreating it, which also detaches any Automation
 * bound to that connection. Rotating keeps the same connection id, so
 * Automations, pipeline/stage destination and history stay intact.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')

    const { plaintext, hash } = generateInboundWebhookToken()

    // Account-scoped update; `.select` tells us whether a row matched, so a
    // foreign or unknown id is a 404 rather than a silent success.
    const { data: updated, error } = await supabase
      .from('inbound_webhooks')
      .update({ token_hash: hash })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'Failed to rotate webhook token' }, { status: 500 })
    }
    if (!updated) {
      return NextResponse.json({ error: 'Webhook connection not found' }, { status: 404 })
    }

    const url = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/webhooks/inbound/${updated.id}?token=${plaintext}`
    return NextResponse.json({ id: updated.id, url, token: plaintext })
  } catch (error) {
    return toErrorResponse(error)
  }
}
