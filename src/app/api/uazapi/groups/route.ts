import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveDefaultChannelForAccount } from '@/lib/whatsapp/resolve-channel'
import { listUazapiGroups } from '@/lib/whatsapp/uazapi-api'

/**
 * GET /api/uazapi/groups
 *
 * WhatsApp groups the account's default channel is already a member
 * of — powers the group picker for the daily digest (Settings →
 * Notifications). Only UAZAPI supports this (no Meta equivalent);
 * Meta-only accounts just get an empty list, so the picker degrades to
 * "no groups available" rather than erroring.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const channel = await resolveDefaultChannelForAccount(supabase, accountId)
    if (!channel || channel.provider !== 'uazapi' || !channel.uazapiBaseUrl || !channel.uazapiInstanceToken) {
      return NextResponse.json({ groups: [] })
    }

    const groups = await listUazapiGroups({
      baseUrl: channel.uazapiBaseUrl,
      instanceToken: channel.uazapiInstanceToken,
    })
    return NextResponse.json({ groups })
  } catch (error) {
    return toErrorResponse(error)
  }
}
