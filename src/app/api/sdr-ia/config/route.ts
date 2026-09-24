// src/app/api/sdr-ia/config/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getSdrIaStatus, getSdrIaConfig, upsertSdrIaConfig } from '@/lib/sdr-ia/config'
import type { SdrIaConfigInput } from '@/lib/sdr-ia/config'

async function assertEnabled(supabase: Parameters<typeof getSdrIaStatus>[0], accountId: string) {
  const enabled = await getSdrIaStatus(supabase, accountId)
  if (!enabled) {
    throw Object.assign(new Error('SDR IA not enabled for this account'), { status: 403 })
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    await assertEnabled(supabase, accountId)
    const config = await getSdrIaConfig(supabase, accountId)
    return NextResponse.json({ config })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      return NextResponse.json({ error: error.message }, { status: (error as { status: number }).status })
    }
    return toErrorResponse(error)
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    await assertEnabled(supabase, accountId)

    const patch = (await request.json()) as Partial<SdrIaConfigInput>
    const config = await upsertSdrIaConfig(supabase, accountId, patch)
    return NextResponse.json({ config })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      return NextResponse.json({ error: error.message }, { status: (error as { status: number }).status })
    }
    return toErrorResponse(error)
  }
}
