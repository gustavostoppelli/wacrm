import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findOpenDealForContact } from './find-or-create-open-deal'

function makeDb(opts: {
  existingDeal?: Record<string, unknown> | null
  contactRow?: Record<string, unknown> | null
  pipelineRows?: Array<{ id: string; name: string }>
  stageRows?: Array<{ id: string; name: string; position: number }>
  createdDealId?: string
}) {
  const state = { dealInserts: [] as Record<string, unknown>[], dealUpdates: [] as Record<string, unknown>[] }
  const db = {
    from: (table: string) => {
      if (table === 'deals') {
        const selectChain = {
          select: () => selectChain,
          eq: () => selectChain,
          order: () => selectChain,
          limit: () => selectChain,
          maybeSingle: () => Promise.resolve({ data: opts.existingDeal ?? null, error: null }),
        }
        return {
          select: () => selectChain,
          insert: (payload: Record<string, unknown>) => {
            state.dealInserts.push(payload)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: opts.createdDealId ?? 'new-deal-1', pipeline_id: payload.pipeline_id, title: payload.title },
                    error: null,
                  }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            state.dealUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contacts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.contactRow ?? null, error: null }) }) }),
        }
      }
      if (table === 'pipelines') {
        const chain = { select: () => chain, eq: () => chain, ilike: () => chain, order: () => chain, limit: () => Promise.resolve({ data: opts.pipelineRows ?? [{ id: 'pipe-1', name: 'Default' }], error: null }) }
        return chain
      }
      if (table === 'pipeline_stages') {
        const chain = { select: () => chain, eq: () => chain, ilike: () => chain, order: () => chain, limit: () => Promise.resolve({ data: opts.stageRows ?? [{ id: 'stage-1', name: 'Novo', position: 0 }], error: null }) }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

describe('findOpenDealForContact', () => {
  it('returns the existing open deal without creating a new one', async () => {
    const { db, state } = makeDb({ existingDeal: { id: 'deal-1', pipeline_id: 'pipe-1', title: 'X', conversation_id: 'conv-1' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toEqual({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X', conversation_id: 'conv-1' })
    expect(state.dealInserts).toHaveLength(0)
  })

  it('creates a deal in the default pipeline/stage, with the contact name as title and user_id set, when none exists', async () => {
    const { db, state } = makeDb({ existingDeal: null, contactRow: { name: 'Julio', phone: '5522998783605' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toMatchObject({ pipeline_id: 'pipe-1', title: 'Julio' })
    expect(state.dealInserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
      title: 'Julio',
      source: 'WhatsApp Direto',
      status: 'open',
    })
  })

  it('falls back to the phone when the contact has no name', async () => {
    const { db } = makeDb({ existingDeal: null, contactRow: { name: null, phone: '5522998783605' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result?.title).toBe('5522998783605')
  })

  it('returns null (never throws) when resolving the pipeline fails', async () => {
    const { db } = makeDb({ existingDeal: null, pipelineRows: [] })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toBeNull()
  })
})
