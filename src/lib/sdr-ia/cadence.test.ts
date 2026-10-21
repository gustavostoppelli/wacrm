import { describe, expect, it } from 'vitest'
import { cadenceText, dueCadenceStep, moveSdrDealStage } from './cadence'

const DAY = 24 * 60 * 60_000
const now = new Date('2026-10-21T12:00:00Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)

const base = { now, t1At: ago(0), t2At: null, t3At: null, exhaustedAt: null, replied: false }

describe('dueCadenceStep', () => {
  it('waits before msg2 (less than 2 days)', () => {
    expect(dueCadenceStep({ ...base, t1At: ago(1.5) })).toBeNull()
  })
  it('msg2 after 2+ days without a reply', () => {
    expect(dueCadenceStep({ ...base, t1At: ago(2.1) })).toBe('msg2')
  })
  it('waits 6 days after msg2 before msg3', () => {
    expect(dueCadenceStep({ ...base, t1At: ago(9), t2At: ago(5.9) })).toBeNull()
    expect(dueCadenceStep({ ...base, t1At: ago(9), t2At: ago(6.1) })).toBe('msg3')
  })
  it('exhausts 3 days after msg3, sends nothing more', () => {
    const s = { ...base, t1At: ago(20), t2At: ago(15), t3At: ago(2.9) }
    expect(dueCadenceStep(s)).toBeNull()
    expect(dueCadenceStep({ ...s, t3At: ago(3.1) })).toBe('exhaust')
  })
  it('a lead that replied is out of the cadence for good', () => {
    expect(dueCadenceStep({ ...base, t1At: ago(30), replied: true })).toBeNull()
  })
  it('an already exhausted lead is ignored', () => {
    expect(dueCadenceStep({ ...base, t1At: ago(30), exhaustedAt: ago(1) })).toBeNull()
  })
})

describe('cadenceText', () => {
  it('msg2 falls back to "vocês" without a company name', () => {
    expect(cadenceText('msg2', '')).toContain('falar com vocês.')
    expect(cadenceText('msg2', 'Dra. Laira')).toContain('falar com Dra. Laira.')
  })
  it('msg3 carries the site link and never leaves a dangling comma', () => {
    expect(cadenceText('msg3', '')).toMatch(/^Oi! /)
    expect(cadenceText('msg3', 'Dra. Laira')).toMatch(/^Oi, Dra\. Laira! /)
    expect(cadenceText('msg3', '')).toContain('fusegrowth.com.br')
  })
})

// Minimal thenable fake of the supabase query builder, keyed by table.
function fakeDb(opts: {
  deals: Array<{ id: string; stage_id: string }>
  stages: Array<{ id: string; name: string; pipeline_id: string }>
}) {
  const updates: Array<{ id: string; stage_id: string }> = []
  const builder = (table: string) => {
    let filterIds: string[] | null = null
    let pipelineId: string | null = null
    let updatePayload: { stage_id: string } | null = null
    let dealId: string | null = null
    const api: Record<string, unknown> = {
      select: () => api,
      update: (p: { stage_id: string }) => {
        updatePayload = p
        return api
      },
      eq: (col: string, val: string) => {
        if (col === 'pipeline_id') pipelineId = val
        if (col === 'id') dealId = val
        return api
      },
      in: (_c: string, vals: string[]) => {
        filterIds = vals
        return api
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'deals' && updatePayload) {
          updates.push({ id: dealId as string, stage_id: updatePayload.stage_id })
          return resolve({ error: null })
        }
        if (table === 'deals') return resolve({ data: opts.deals })
        let rows = opts.stages
        if (filterIds) rows = rows.filter((s) => filterIds!.includes(s.id))
        if (pipelineId) rows = rows.filter((s) => s.pipeline_id === pipelineId)
        return resolve({ data: rows })
      },
    }
    return api
  }
  return { db: { from: builder } as never, updates }
}

const stages = [
  { id: 's-novo', name: 'Novo Lead', pipeline_id: 'p1' },
  { id: 's-1', name: 'Primeiro Contato', pipeline_id: 'p1' },
  { id: 's-2', name: 'Segundo Contato', pipeline_id: 'p1' },
  { id: 's-esg', name: 'Lead Frio Esgotado', pipeline_id: 'p1' },
  { id: 's-reuniao', name: 'Reunião Agendada', pipeline_id: 'p1' },
  { id: 'other-1', name: 'Primeiro Contato', pipeline_id: 'p2' },
]

describe('moveSdrDealStage', () => {
  it('moves Novo Lead → Primeiro Contato inside the deal pipeline', async () => {
    const { db, updates } = fakeDb({ deals: [{ id: 'd1', stage_id: 's-novo' }], stages })
    const moved = await moveSdrDealStage(db, 'a1', 'c1', 'Primeiro Contato')
    expect(moved).toBe(1)
    expect(updates).toEqual([{ id: 'd1', stage_id: 's-1' }])
  })

  it('never moves backwards', async () => {
    const { db, updates } = fakeDb({ deals: [{ id: 'd1', stage_id: 's-2' }], stages })
    expect(await moveSdrDealStage(db, 'a1', 'c1', 'Primeiro Contato')).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('leaves a deal a human moved to another column alone', async () => {
    const { db, updates } = fakeDb({ deals: [{ id: 'd1', stage_id: 's-reuniao' }], stages })
    expect(await moveSdrDealStage(db, 'a1', 'c1', 'Lead Frio Esgotado')).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('matches the target name ignoring case and accents', async () => {
    const { db, updates } = fakeDb({ deals: [{ id: 'd1', stage_id: 's-1' }], stages })
    expect(await moveSdrDealStage(db, 'a1', 'c1', 'lead frio esgotado')).toBe(1)
    expect(updates[0].stage_id).toBe('s-esg')
  })
})
