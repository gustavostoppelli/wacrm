import { describe, expect, it } from 'vitest'
import { checkWhatsappChannelLimit } from './channel-limit'

function makeDb(opts: { limit?: number; count: number }) {
  return {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.limit !== undefined ? { whatsapp_channel_limit: opts.limit } : null,
                }),
            }),
          }),
        }
      }
      // whatsapp_config count query
      return {
        select: () => ({
          eq: () => Promise.resolve({ count: opts.count }),
        }),
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('checkWhatsappChannelLimit', () => {
  it('allows creation when under the account limit', async () => {
    const result = await checkWhatsappChannelLimit(makeDb({ limit: 2, count: 1 }), 'acct-1')
    expect(result).toEqual({ ok: true, limit: 2, count: 1 })
  })

  it('blocks creation once the account is at its limit', async () => {
    const result = await checkWhatsappChannelLimit(makeDb({ limit: 1, count: 1 }), 'acct-1')
    expect(result.ok).toBe(false)
    expect(result.limit).toBe(1)
    expect(result.count).toBe(1)
  })

  it('blocks creation when already over the limit (limit lowered after the fact)', async () => {
    const result = await checkWhatsappChannelLimit(makeDb({ limit: 1, count: 2 }), 'acct-1')
    expect(result.ok).toBe(false)
  })

  it('defaults to a limit of 1 when the account row has no explicit value', async () => {
    const result = await checkWhatsappChannelLimit(makeDb({ count: 0 }), 'acct-1')
    expect(result).toEqual({ ok: true, limit: 1, count: 0 })

    const blocked = await checkWhatsappChannelLimit(makeDb({ count: 1 }), 'acct-1')
    expect(blocked.ok).toBe(false)
    expect(blocked.limit).toBe(1)
  })
})
