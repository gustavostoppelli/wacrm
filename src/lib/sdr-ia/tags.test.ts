import { describe, expect, it, vi } from 'vitest'
import { resolveOrCreateTagId, variantTagName } from './tags'

function makeDb(opts: {
  existingId?: string
  insertError?: { message: string } | null
}) {
  const inserted: Record<string, unknown>[] = []
  const eqSpy = vi.fn().mockReturnValue({
    ilike: () => ({
      maybeSingle: () =>
        Promise.resolve({ data: opts.existingId ? { id: opts.existingId } : null }),
    }),
  })

  const insertSpy = vi.fn((row: Record<string, unknown>) => {
    inserted.push(row)
    return {
      select: () => ({
        single: () =>
          Promise.resolve({
            data: opts.insertError ? null : { id: 'new-tag-id' },
            error: opts.insertError,
          }),
      }),
    }
  })

  return {
    from: () => ({
      select: () => ({
        eq: eqSpy,
      }),
      insert: insertSpy,
    }),
    _eqSpy: eqSpy,
    _insertSpy: insertSpy,
    _inserted: inserted,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('resolveOrCreateTagId', () => {
  it('returns the existing tag id when a case-insensitive match exists', async () => {
    const db = makeDb({ existingId: 'tag-1' })
    const id = await resolveOrCreateTagId(db, 'acct-1', 'user-1', 'Prospecção')
    expect(id).toBe('tag-1')
    // Assert account-scoping was applied on the select path
    expect(db._eqSpy).toHaveBeenCalledWith('account_id', 'acct-1')
  })

  it('creates a new tag when none matches', async () => {
    const db = makeDb({})
    const id = await resolveOrCreateTagId(db, 'acct-1', 'user-1', 'sdr_ia_contatado')
    expect(id).toBe('new-tag-id')
    // Assert account-scoping on insert row
    expect(db._inserted).toHaveLength(1)
    expect(db._inserted[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      name: 'sdr_ia_contatado',
      color: '#3b82f6',
    })
    // Assert insert was called with the row
    expect(db._insertSpy).toHaveBeenCalled()
  })

  it('throws with a clear error message when insert fails', async () => {
    const db = makeDb({ insertError: { message: 'unique constraint violated' } })
    await expect(
      resolveOrCreateTagId(db, 'acct-1', 'user-1', 'sdr_ia_contatado'),
    ).rejects.toThrow('Failed to create tag "sdr_ia_contatado": unique constraint violated')
  })
})

describe('variantTagName', () => {
  it('formats a 1-indexed variant tag name', () => {
    expect(variantTagName(1)).toBe('sdr_ia_variante_1')
    expect(variantTagName(3)).toBe('sdr_ia_variante_3')
  })
})
