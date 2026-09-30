import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/whatsapp/status
 *
 * Whether this account can access WhatsApp channel setup
 * (accounts.whatsapp_enabled, migration 076). The Settings → WhatsApp
 * panel uses this to decide between the locked view and the real
 * official-API/UAZAPI config UI — checked server-side, same reasoning
 * as /api/instagram/status and /api/sdr-ia/status.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { data } = await supabase
      .from('accounts')
      .select('whatsapp_enabled')
      .eq('id', accountId)
      .maybeSingle()
    return NextResponse.json({ enabled: !!data?.whatsapp_enabled })
  } catch (error) {
    return toErrorResponse(error)
  }
}
