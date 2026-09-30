import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * PATCH /api/account/webhooks/[id]
 *
 * Admin-only. Two independent, optionally-combined updates:
 *   - is_active: enable/disable the connection.
 *   - pipeline_id/stage_id: change (or clear) the connection's fixed
 *     deal destination (migration 077) — e.g. switching an existing
 *     connection from "auto-create the deal here" to "let the
 *     Automation's own 'Criar negócio' step decide" without needing
 *     to delete and recreate the connection (which would rotate its
 *     URL/token and break whatever external tool already has it).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')

    const body = await request.json()
    const { is_active, pipeline_id, stage_id } = body as {
      is_active?: boolean
      pipeline_id?: string | null
      stage_id?: string | null
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = {}

    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
      }
      update.is_active = is_active
    }

    if (pipeline_id !== undefined || stage_id !== undefined) {
      // Same pairing rule as POST: both set, or both cleared.
      if ((pipeline_id && !stage_id) || (!pipeline_id && stage_id)) {
        return NextResponse.json(
          { error: 'pipeline_id and stage_id must be set together, or both left empty' },
          { status: 400 },
        )
      }
      if (pipeline_id && stage_id) {
        const { data: stage, error: stageError } = await supabase
          .from('pipeline_stages')
          .select('id, pipeline_id')
          .eq('id', stage_id)
          .eq('pipeline_id', pipeline_id)
          .maybeSingle()
        if (stageError || !stage) {
          return NextResponse.json({ error: 'Invalid pipeline_id/stage_id' }, { status: 400 })
        }
      }
      update.pipeline_id = pipeline_id || null
      update.stage_id = stage_id || null
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { error } = await supabase
      .from('inbound_webhooks')
      .update(update)
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
