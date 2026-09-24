import { describe, expect, it, vi } from 'vitest'
import { getSdrIaStatus, getSdrIaConfig, upsertSdrIaConfig } from './config'

function makeDb(opts: { sdrIaEnabled?: boolean; configRow?: Record<string, unknown> | null }) {
  return {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { sdr_ia_enabled: opts.sdrIaEnabled ?? false } }),
            }),
          }),
        }
      }
      // sdr_ia_config
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.configRow ?? null }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { account_id: 'acct-1', ...row }, error: null }),
          }),
        }),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
  } as any
}

describe('getSdrIaStatus', () => {
  it('returns false when accounts.sdr_ia_enabled is false', async () => {
    const result = await getSdrIaStatus(makeDb({ sdrIaEnabled: false }), 'acct-1')
    expect(result).toBe(false)
  })

  it('returns true when accounts.sdr_ia_enabled is true', async () => {
    const result = await getSdrIaStatus(makeDb({ sdrIaEnabled: true }), 'acct-1')
    expect(result).toBe(true)
  })
})

describe('getSdrIaConfig', () => {
  it('returns null when the account has no config row yet', async () => {
    const result = await getSdrIaConfig(makeDb({ configRow: null }), 'acct-1')
    expect(result).toBeNull()
  })

  it('maps the DB row to SdrIaConfig', async () => {
    const result = await getSdrIaConfig(
      makeDb({
        configRow: {
          account_id: 'acct-1',
          enabled: true,
          lead_tag_id: 'tag-1',
          contacted_tag_id: 'tag-2',
          whatsapp_config_id: 'chan-1',
          send_mode: 'text',
          template_name: null,
          template_language: null,
          message_variants: ['Oi!'],
          daily_cap: 5,
          hours_start: 9,
          hours_end: 18,
        },
      }),
      'acct-1',
    )
    expect(result).toEqual(
      expect.objectContaining({ accountId: 'acct-1', sendMode: 'text', dailyCap: 5 }),
    )
  })
})

describe('upsertSdrIaConfig', () => {
  it('writes the patch and returns the updated config', async () => {
    const db = makeDb({})
    const result = await upsertSdrIaConfig(db, 'acct-1', { dailyCap: 10 })
    expect(result.accountId).toBe('acct-1')
  })
})
