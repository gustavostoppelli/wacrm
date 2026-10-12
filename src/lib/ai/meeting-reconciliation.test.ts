import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  ensureMeetingScheduled: vi.fn(),
  loadAiConfig: vi.fn(),
  engineSendText: vi.fn(),
}))
vi.mock('./meeting-scheduling', () => ({ ensureMeetingScheduled: h.ensureMeetingScheduled }))
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

import { reconcileMeetingIntents } from './meeting-reconciliation'

function makeDb(intents: Record<string, unknown>[]) {
  const state = { updates: [] as Array<{ payload: Record<string, unknown>; id: string }> }
  const db = {
    from: (table: string) => {
      if (table === 'ai_meeting_intents') {
        const selectChain = {
          select: () => selectChain,
          is: () => selectChain,
          gte: () => selectChain,
          order: () => Promise.resolve({ data: intents, error: null }),
        }
        return {
          select: () => selectChain,
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              state.updates.push({ payload, id })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const NOW = new Date('2026-10-12T12:00:00.000Z')

function intent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'intent-1',
    account_id: 'acct-1',
    conversation_id: 'conv-1',
    contact_id: 'contact-1',
    config_owner_user_id: 'user-1',
    meeting_at: '2026-10-12T13:00:00.000Z', // 1h no futuro
    meeting_email: 'lead@example.com',
    meeting_note: 'Hoje às 10h',
    created_at: '2026-10-12T09:00:00.000Z', // mais de 15min atrás
    ...overrides,
  }
}

beforeEach(() => {
  h.ensureMeetingScheduled.mockReset()
  h.loadAiConfig.mockReset()
  h.engineSendText.mockReset()
  h.loadAiConfig.mockResolvedValue({ meetingEventLabel: null, businessHoursTimezone: 'America/Sao_Paulo' })
})

describe('reconcileMeetingIntents', () => {
  it('retries an unresolved intent whose meeting time is still in the future', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1', intentId: 'intent-1' }),
    )
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 0 })
  })

  it('retries an intent up to 3h past its meeting time', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const { db } = makeDb([intent({ meeting_at: '2026-10-12T10:00:00.000Z' })]) // 2h no passado
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalled()
    expect(result.completed).toBe(1)
  })

  it('does not retry (and instead asks to reschedule) an intent more than 3h past its meeting time', async () => {
    h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
    const { db, state } = makeDb([intent({ meeting_at: '2026-10-12T08:00:00.000Z' })]) // 4h no passado
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1' }),
    )
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'stale_rescheduled' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 1, stillPending: 0, superseded: 0 })
  })

  it('counts an intent as still pending when ensureMeetingScheduled could not complete it', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 1, superseded: 0 })
  })

  it('skips an intent created less than 15 minutes ago, to not race a live in-flight attempt', async () => {
    const { db } = makeDb([intent({ created_at: '2026-10-12T11:50:00.000Z' })]) // 10min atrás
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0 })
  })

  // ------------------------------------------------------------
  // Supersede-grouping: two reviewers flagged (Tasks 3 and 4) that
  // every re-emission of the meeting tag -- including a later,
  // successful reschedule -- creates a BRAND NEW ai_meeting_intents
  // row. An older row for the same conversation can stay unresolved
  // (e.g. it failed because Calendar was briefly disconnected) even
  // after a newer intent for that same conversation already
  // succeeded with a different time. Retrying the stale older intent
  // after the newer one succeeded would trigger a REAL reschedule
  // (ensureMeetingScheduled's idempotency guard only short-circuits
  // on an exact time match), silently moving the lead's meeting back
  // to the old, stale time. This must never reach ensureMeetingScheduled.
  // ------------------------------------------------------------
  it('supersedes every unresolved intent for a conversation except the newest, without retrying the stale ones', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const older = intent({
      id: 'intent-old',
      created_at: '2026-10-12T09:00:00.000Z', // mais de 15min atrás
      meeting_at: '2026-10-12T10:00:00.000Z', // 2h no passado, ainda dentro da janela de retry
    })
    const newer = intent({
      id: 'intent-new',
      created_at: '2026-10-12T09:30:00.000Z', // mais de 15min atrás, criado depois do older
      meeting_at: '2026-10-12T13:00:00.000Z', // 1h no futuro
    })
    const { db, state } = makeDb([older, newer])
    const result = await reconcileMeetingIntents(db as never, NOW)

    expect(h.ensureMeetingScheduled).toHaveBeenCalledTimes(1)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ intentId: 'intent-new', meetingAt: '2026-10-12T13:00:00.000Z' }),
    )

    const supersedeUpdate = state.updates.find((u) => u.id === 'intent-old')
    expect(supersedeUpdate).toMatchObject({ payload: { resolution: 'superseded' } })
    expect(supersedeUpdate?.payload.resolved_at).toBeTruthy()

    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 1 })
  })
})
