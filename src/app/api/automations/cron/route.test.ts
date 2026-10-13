import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// reconcileMeetingIntentsOnce is the cron-wiring/claim function around
// reconcileMeetingIntents (tested separately and thoroughly in
// meeting-reconciliation.test.ts). Here it's mocked out entirely so
// these tests stay focused on the claim/business-hours wiring itself,
// not on what the job does once claimed.
const h = vi.hoisted(() => ({
  reconcileMeetingIntents: vi.fn(),
}))
vi.mock('@/lib/ai/meeting-reconciliation', () => ({
  reconcileMeetingIntents: h.reconcileMeetingIntents,
}))

import { reconcileMeetingIntentsOnce } from './route'

// Minimal fake admin client -- only implements the `cron_job_state`
// shape reconcileMeetingIntentsOnce actually touches (select/eq/maybeSingle,
// insert, update/eq/or/select/maybeSingle). Any other table access
// throws, since this function should never touch anything else.
function makeAdmin(opts: {
  initialLastRunDate: string | null | undefined // undefined = no row at all (maybeSingle -> null)
  insertError?: { message: string } | null
  updateClaimResult?: { job_name: string } | null
}) {
  const calls: string[] = []
  const admin = {
    from: (table: string) => {
      if (table !== 'cron_job_state') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              calls.push('select')
              const data =
                opts.initialLastRunDate === undefined
                  ? null
                  : { last_run_date: opts.initialLastRunDate }
              return Promise.resolve({ data, error: null })
            },
          }),
        }),
        insert: (_payload: Record<string, unknown>) => {
          calls.push('insert')
          return Promise.resolve({ error: opts.insertError ?? null })
        },
        update: (_payload: Record<string, unknown>) => ({
          eq: () => ({
            or: () => ({
              select: () => ({
                maybeSingle: () => {
                  calls.push('update')
                  return Promise.resolve({ data: opts.updateClaimResult ?? null, error: null })
                },
              }),
            }),
          }),
        }),
      }
    },
  }
  return { admin, calls }
}

// 14:00 UTC = 11:00 America/Sao_Paulo (fixed UTC-3, no DST in Brazil
// since 2019) on the same calendar day -- inside the 09h-18h window,
// "today" is 2026-10-13.
const WITHIN_BUSINESS_HOURS = new Date('2026-10-13T14:00:00.000Z')
const TODAY = '2026-10-13'
const YESTERDAY = '2026-10-12'

beforeEach(() => {
  h.reconcileMeetingIntents.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reconcileMeetingIntentsOnce', () => {
  it('skips without touching the DB when outside the 09h-18h America/Sao_Paulo window', async () => {
    // 02:00 UTC = 23:00 America/Sao_Paulo the previous day -- well
    // outside the window.
    vi.setSystemTime(new Date('2026-10-13T02:00:00.000Z'))
    const { admin, calls } = makeAdmin({ initialLastRunDate: undefined })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(result).toBeNull()
    expect(h.reconcileMeetingIntents).not.toHaveBeenCalled()
    expect(calls).toEqual([]) // never even checked cron_job_state
  })

  it('does not claim again when last_run_date already matches today', async () => {
    vi.setSystemTime(WITHIN_BUSINESS_HOURS)
    const { admin } = makeAdmin({ initialLastRunDate: TODAY })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(result).toBeNull()
    expect(h.reconcileMeetingIntents).not.toHaveBeenCalled()
  })

  it('claims via INSERT and runs the job when the cron_job_state row does not exist yet', async () => {
    vi.setSystemTime(WITHIN_BUSINESS_HOURS)
    h.reconcileMeetingIntents.mockResolvedValue({
      completed: 1,
      rescheduled: 0,
      stillPending: 0,
      superseded: 0,
    })
    const { admin } = makeAdmin({ initialLastRunDate: undefined, insertError: null })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(h.reconcileMeetingIntents).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 0 })
  })

  it('does not run the job when the INSERT claim loses to a concurrent invocation', async () => {
    vi.setSystemTime(WITHIN_BUSINESS_HOURS)
    const { admin } = makeAdmin({
      initialLastRunDate: undefined,
      insertError: { message: 'duplicate key value violates unique constraint' },
    })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(result).toBeNull()
    expect(h.reconcileMeetingIntents).not.toHaveBeenCalled()
  })

  it('claims via the conditional UPDATE and runs the job when the row exists with an older date', async () => {
    vi.setSystemTime(WITHIN_BUSINESS_HOURS)
    h.reconcileMeetingIntents.mockResolvedValue({
      completed: 0,
      rescheduled: 0,
      stillPending: 0,
      superseded: 0,
    })
    const { admin } = makeAdmin({
      initialLastRunDate: YESTERDAY,
      updateClaimResult: { job_name: 'reconcile_meeting_intents' },
    })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(h.reconcileMeetingIntents).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0 })
  })

  it('does not run the job when the conditional UPDATE claim loses to a concurrent invocation', async () => {
    vi.setSystemTime(WITHIN_BUSINESS_HOURS)
    const { admin } = makeAdmin({
      initialLastRunDate: YESTERDAY,
      updateClaimResult: null, // another invocation already flipped it to today
    })

    const result = await reconcileMeetingIntentsOnce(admin as never)

    expect(result).toBeNull()
    expect(h.reconcileMeetingIntents).not.toHaveBeenCalled()
  })
})
