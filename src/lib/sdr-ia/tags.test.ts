import { describe, expect, it } from 'vitest'
import { resolveOrCreateTagId, variantTagName } from './tags'

function makeDb(opts: { existingId?: string }) {
  const inserted: Record<string, unknown>[] = []
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          ilike: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: opts.existingId ? { id: opts.existingId } : null }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'new-tag-id' }, error: null }),
          }),
        }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('resolveOrCreateTagId', () => {
  it('returns the existing tag id when a case-insensitive match exists', async () => {
    const id = await resolveOrCreateTagId(makeDb({ existingId: 'tag-1' }), 'acct-1', 'user-1', 'Prospecção')
    expect(id).toBe('tag-1')
  })

  it('creates a new tag when none matches', async () => {
    const id = await resolveOrCreateTagId(makeDb({}), 'acct-1', 'user-1', 'sdr_ia_contatado')
    expect(id).toBe('new-tag-id')
  })
})

describe('variantTagName', () => {
  it('formats a 1-indexed variant tag name', () => {
    expect(variantTagName(1)).toBe('sdr_ia_variante_1')
    expect(variantTagName(3)).toBe('sdr_ia_variante_3')
  })
})
