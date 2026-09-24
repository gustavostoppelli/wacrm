// ============================================================
// SDR IA per-account config (migration 070).
//
// Two independent gates, don't confuse them:
//   - accounts.sdr_ia_enabled — whether this account may access the
//     feature at all (visibility gate; set via SQL by Fuse today).
//   - sdr_ia_config.enabled — whether the account's own automation is
//     actively running (the account's own on/off switch, flipped by
//     the wizard's last step).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type SdrIaSendMode = 'template' | 'text'

export interface SdrIaConfig {
  accountId: string
  enabled: boolean
  leadTagId: string | null
  contactedTagId: string | null
  whatsappConfigId: string | null
  sendMode: SdrIaSendMode
  templateName: string | null
  templateLanguage: string | null
  messageVariants: string[]
  dailyCap: number
  hoursStart: number
  hoursEnd: number
}

export type SdrIaConfigInput = Omit<SdrIaConfig, 'accountId'>

export async function getSdrIaStatus(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('accounts')
    .select('sdr_ia_enabled')
    .eq('id', accountId)
    .maybeSingle()
  return !!data?.sdr_ia_enabled
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(row: any): SdrIaConfig {
  return {
    accountId: row.account_id,
    enabled: !!row.enabled,
    leadTagId: row.lead_tag_id,
    contactedTagId: row.contacted_tag_id,
    whatsappConfigId: row.whatsapp_config_id,
    sendMode: row.send_mode,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    messageVariants: Array.isArray(row.message_variants) ? row.message_variants : [],
    dailyCap: row.daily_cap,
    hoursStart: row.hours_start,
    hoursEnd: row.hours_end,
  }
}

export async function getSdrIaConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<SdrIaConfig | null> {
  const { data } = await db
    .from('sdr_ia_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  return data ? fromRow(data) : null
}

export async function upsertSdrIaConfig(
  db: SupabaseClient,
  accountId: string,
  patch: Partial<SdrIaConfigInput>,
): Promise<SdrIaConfig> {
  const row = {
    account_id: accountId,
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.leadTagId !== undefined && { lead_tag_id: patch.leadTagId }),
    ...(patch.contactedTagId !== undefined && { contacted_tag_id: patch.contactedTagId }),
    ...(patch.whatsappConfigId !== undefined && { whatsapp_config_id: patch.whatsappConfigId }),
    ...(patch.sendMode !== undefined && { send_mode: patch.sendMode }),
    ...(patch.templateName !== undefined && { template_name: patch.templateName }),
    ...(patch.templateLanguage !== undefined && { template_language: patch.templateLanguage }),
    ...(patch.messageVariants !== undefined && { message_variants: patch.messageVariants }),
    ...(patch.dailyCap !== undefined && { daily_cap: patch.dailyCap }),
    ...(patch.hoursStart !== undefined && { hours_start: patch.hoursStart }),
    ...(patch.hoursEnd !== undefined && { hours_end: patch.hoursEnd }),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await db
    .from('sdr_ia_config')
    .upsert(row, { onConflict: 'account_id' })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to save SDR IA config: ${error?.message}`)
  }
  return fromRow(data)
}
