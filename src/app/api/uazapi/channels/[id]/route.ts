import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { deleteInstance } from '@/lib/whatsapp/uazapi-api'

/**
 * PATCH /api/uazapi/channels/[id]
 *
 * Updates settings on an existing channel — `ai_enabled` (migration
 * 058, the per-channel opt-out for the AI agent) and/or `assigned_to`
 * (migration 060, which teammate can complete the QR pairing without
 * being an admin — pass `null` to unassign). Admin-only either way,
 * mirroring who can create/delete a channel.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await context.params

    const body = await request.json()
    const updates: Record<string, boolean | string | null> = {}
    if (typeof body?.ai_enabled === 'boolean') updates.ai_enabled = body.ai_enabled
    if ('assigned_to' in body) {
      if (body.assigned_to !== null && typeof body.assigned_to !== 'string') {
        return NextResponse.json({ error: 'assigned_to must be a string or null' }, { status: 400 })
      }
      if (body.assigned_to) {
        // Same auth.users-id convention as POST /api/uazapi/channels —
        // profiles.user_id, not profiles.id.
        const { data: assignee } = await supabase
          .from('profiles')
          .select('id')
          .eq('user_id', body.assigned_to)
          .eq('account_id', accountId)
          .maybeSingle()
        if (!assignee) {
          return NextResponse.json(
            { error: 'assigned_to must be a member of this account' },
            { status: 400 },
          )
        }
      }
      updates.assigned_to = body.assigned_to
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'ai_enabled and/or assigned_to is required' },
        { status: 400 },
      )
    }

    const { data: row, error } = await supabase
      .from('whatsapp_config')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .select('id, ai_enabled, assigned_to')
      .maybeSingle()

    if (error || !row) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, channel: row })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/uazapi/channels/[id]
 *
 * Disconnects and removes a UAZAPI channel. Deletes the instance on
 * the UAZAPI server (best-effort — a server that's already gone
 * shouldn't block removing our own record) then the whatsapp_config
 * row. Conversation history is preserved: `conversations.whatsapp_config_id`
 * is `ON DELETE SET NULL` (migration 037), not cascading.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await context.params

    const { data: channel, error: fetchError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()

    if (fetchError || !channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    try {
      await deleteInstance({
        baseUrl: channel.uazapi_base_url,
        instanceToken: decrypt(channel.uazapi_instance_token),
      })
    } catch (err) {
      console.warn('[uazapi/channels] instance delete failed (non-fatal):', err)
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('[uazapi/channels] delete error:', deleteError)
      return NextResponse.json({ error: 'Failed to delete channel' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
