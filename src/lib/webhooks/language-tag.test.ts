import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const addTag = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: addTag }))

import { resolveContactLanguage } from './language-tag'

/** Minimal chainable stand-in for the three queries the helper makes. */
function fakeDb(opts: { contactTagNames?: string[]; tagExists?: boolean }) {
  const inserted: unknown[] = []
  const db = {
    from(table: string) {
      if (table === 'contact_tags') {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.in = () =>
          Promise.resolve({
            data: (opts.contactTagNames ?? []).map((name) => ({ tags: { name } })),
          })
        return q
      }
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.limit = () => q
      q.maybeSingle = () =>
        Promise.resolve({ data: opts.tagExists ? { id: 'tag-es' } : null })
      q.insert = (row: unknown) => {
        inserted.push(row)
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'tag-new' }, error: null }) }) }
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, inserted }
}

const base = { accountId: 'a', userId: 'u', contactId: 'c', countryIso: null }

describe('resolveContactLanguage', () => {
  it('tags a Spanish-speaking lead with idioma_es', async () => {
    addTag.mockClear()
    const { db } = fakeDb({ tagExists: true })
    expect(await resolveContactLanguage(db, { ...base, phone: '5491145678901' })).toBe('es')
    expect(addTag).toHaveBeenCalledWith(db, { accountId: 'a', contactId: 'c', tagId: 'tag-es' })
  })

  it('creates the idioma_es tag the first time', async () => {
    addTag.mockClear()
    const { db, inserted } = fakeDb({ tagExists: false })
    await resolveContactLanguage(db, { ...base, phone: '34612345678' })
    expect(inserted).toHaveLength(1)
    expect((inserted[0] as { name: string }).name).toBe('idioma_es')
    expect(addTag).toHaveBeenCalledWith(db, { accountId: 'a', contactId: 'c', tagId: 'tag-new' })
  })

  it('does not tag Portuguese leads', async () => {
    addTag.mockClear()
    const { db } = fakeDb({})
    expect(await resolveContactLanguage(db, { ...base, phone: '5511999998888' })).toBe('pt')
    expect(addTag).not.toHaveBeenCalled()
  })

  it('a manual idioma_pt beats a Spanish guess', async () => {
    addTag.mockClear()
    const { db } = fakeDb({ contactTagNames: ['idioma_pt'], tagExists: true })
    expect(await resolveContactLanguage(db, { ...base, phone: '5491145678901' })).toBe('pt')
    expect(addTag).not.toHaveBeenCalled()
  })

  it('an existing idioma_es beats a Portuguese guess', async () => {
    addTag.mockClear()
    const { db } = fakeDb({ contactTagNames: ['idioma_es'] })
    expect(await resolveContactLanguage(db, { ...base, phone: '5511999998888' })).toBe('es')
    expect(addTag).not.toHaveBeenCalled()
  })
})
