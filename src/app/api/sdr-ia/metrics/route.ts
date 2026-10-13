// src/app/api/sdr-ia/metrics/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getSdrIaStatus, getSdrIaConfig } from '@/lib/sdr-ia/config'
import { computeSdrIaMetrics } from '@/lib/sdr-ia/metrics'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const enabled = await getSdrIaStatus(supabase, accountId)
    if (!enabled) {
      return NextResponse.json({ error: 'SDR IA not enabled for this account' }, { status: 403 })
    }

    const url = new URL(request.url)
    const daysParam = Number(url.searchParams.get('days'))
    const days = Number.isInteger(daysParam) && daysParam > 0 && daysParam <= 90 ? daysParam : 14

    const config = await getSdrIaConfig(supabase, accountId)
    const metrics = await computeSdrIaMetrics(supabase, accountId, config?.contactedTagId ?? null, days)
    return NextResponse.json({ metrics })
  } catch (error) {
    return toErrorResponse(error)
  }
}
