import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * PATCH /api/account/webhooks/[id]
 *
 * Enable/disable a connection. Admin-only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')

    const body = await request.json()
    const { is_active } = body as { is_active?: boolean }
    if (typeof is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }

    const { error } = await supabase
      .from('inbound_webhooks')
      .update({ is_active })
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) {
      return NextResponse.json({ error: 'Failed to update webhook connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/account/webhooks/[id]
 *
 * Admin-only. Any automation with trigger_config.webhook_id pointing
 * here just falls back to matching "any connection" going forward
 * (see triggerMatches in engine.ts) rather than erroring.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')

    const { error } = await supabase
      .from('inbound_webhooks')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) {
      return NextResponse.json({ error: 'Failed to delete webhook connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
