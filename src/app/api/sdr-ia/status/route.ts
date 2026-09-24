// src/app/api/sdr-ia/status/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getSdrIaStatus } from '@/lib/sdr-ia/config'

/**
 * GET /api/sdr-ia/status
 *
 * Whether this account can access the SDR IA feature
 * (accounts.sdr_ia_enabled). The /sdr-ia page calls this to decide
 * between the locked marketing view and the real config wizard —
 * checked server-side, never trusted from a client-held flag, so a
 * customer can't unlock the page by editing local state.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const enabled = await getSdrIaStatus(supabase, accountId)
    return NextResponse.json({ enabled })
  } catch (error) {
    return toErrorResponse(error)
  }
}
