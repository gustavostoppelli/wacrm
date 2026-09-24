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

    const body = await request.json()
    const patch = body as {
      enabled?: unknown
      leadTagId?: unknown
      contactedTagId?: unknown
      whatsappConfigId?: unknown
      sendMode?: unknown
      templateName?: unknown
      templateLanguage?: unknown
      messageVariants?: unknown
      dailyCap?: unknown
      hoursStart?: unknown
      hoursEnd?: unknown
    }

    // Validate sendMode if present
    if (patch.sendMode !== undefined && patch.sendMode !== 'template' && patch.sendMode !== 'text') {
      return NextResponse.json(
        { error: 'sendMode must be "template" or "text"' },
        { status: 400 },
      )
    }

    // Validate hoursStart if present
    if (patch.hoursStart !== undefined) {
      if (!Number.isInteger(patch.hoursStart) || (patch.hoursStart as number) < 0 || (patch.hoursStart as number) > 23) {
        return NextResponse.json(
          { error: 'hoursStart must be an integer between 0 and 23' },
          { status: 400 },
        )
      }
    }

    // Validate hoursEnd if present
    if (patch.hoursEnd !== undefined) {
      if (!Number.isInteger(patch.hoursEnd) || (patch.hoursEnd as number) < 0 || (patch.hoursEnd as number) > 23) {
        return NextResponse.json(
          { error: 'hoursEnd must be an integer between 0 and 23' },
          { status: 400 },
        )
      }
    }

    // Validate dailyCap if present
    if (patch.dailyCap !== undefined) {
      if (!Number.isInteger(patch.dailyCap) || (patch.dailyCap as number) <= 0) {
        return NextResponse.json(
          { error: 'dailyCap must be a positive integer' },
          { status: 400 },
        )
      }
    }

    // Validate messageVariants if present
    if (patch.messageVariants !== undefined) {
      if (!Array.isArray(patch.messageVariants)) {
        return NextResponse.json(
          { error: 'messageVariants must be an array' },
          { status: 400 },
        )
      }
      if (patch.messageVariants.length > 3) {
        return NextResponse.json(
          { error: 'messageVariants must have at most 3 items' },
          { status: 400 },
        )
      }
      if (!patch.messageVariants.every((v) => typeof v === 'string')) {
        return NextResponse.json(
          { error: 'messageVariants must contain only strings' },
          { status: 400 },
        )
      }
    }

    const config = await upsertSdrIaConfig(supabase, accountId, patch as Partial<SdrIaConfigInput>)
    return NextResponse.json({ config })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      return NextResponse.json({ error: error.message }, { status: (error as { status: number }).status })
    }
    return toErrorResponse(error)
  }
}
