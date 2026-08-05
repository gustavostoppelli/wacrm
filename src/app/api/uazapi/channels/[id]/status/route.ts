import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'

/**
 * GET /api/uazapi/channels/[id]/status
 *
 * Polled by the QR-code screen while waiting for the scan, and by the
 * channel list to show live connection state. Syncs UAZAPI's live
 * status onto `whatsapp_config.status`/`connected_at` as a side
 * effect, mirroring how Meta's `/config` GET keeps `status` fresh.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await context.params

    const { data: channel, error: fetchError } = await supabase
      .from('whatsapp_config')
      .select('uazapi_base_url, uazapi_instance_token, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()

    if (fetchError || !channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const result = await getInstanceStatus({
      baseUrl: channel.uazapi_base_url,
      instanceToken: decrypt(channel.uazapi_instance_token),
    })

    const newStatus = result.connected ? 'connected' : 'disconnected'
    if (newStatus !== channel.status) {
      await supabase
        .from('whatsapp_config')
        .update({
          status: newStatus,
          connected_at: newStatus === 'connected' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
    }

    return NextResponse.json({ ...result, status: newStatus })
  } catch (error) {
    if (error instanceof Error && !('status' in error)) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return toErrorResponse(error)
  }
}
