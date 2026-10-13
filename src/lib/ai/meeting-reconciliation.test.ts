import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  ensureMeetingScheduled: vi.fn(),
  loadAiConfig: vi.fn(),
  engineSendText: vi.fn(),
  scheduleMeetingReminders: vi.fn(),
}))
vi.mock('./meeting-scheduling', () => ({ ensureMeetingScheduled: h.ensureMeetingScheduled }))
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./auto-reply', () => ({ scheduleMeetingReminders: h.scheduleMeetingReminders }))

import { reconcileMeetingIntents } from './meeting-reconciliation'

// `allIntents` backs the second, unfiltered-by-resolved_at query the
// implementation issues to find siblings for the supersede check --
// it must include rows the first query (unresolved-only) wouldn't
// see, e.g. an already-`completed` intent for the same conversation.
// Defaults to the same list as the unresolved one when a test doesn't
// care about that distinction.
interface DealsConfig {
  /** The contact's open deal, as `findMatchingMeetingLinkOnOpenDeal`
   *  and `contactHasOnlyClosedDeals`' first query would see it. `null`
   *  (default) means no open deal. */
  openDeal?: Record<string, unknown> | null
  /** Whether the contact has at least one deal with `status != 'open'`
   *  -- feeds `contactHasOnlyClosedDeals`'s second query. */
  hasNonOpenDeal?: boolean
}

function makeDb(
  intents: Record<string, unknown>[],
  allIntents: Record<string, unknown>[] = intents,
  dealsConfig: DealsConfig = {},
) {
  const state = { updates: [] as Array<{ payload: Record<string, unknown>; id: string }> }
  const db = {
    from: (table: string) => {
      if (table === 'ai_meeting_intents') {
        return {
          select: () => {
            // The chain doesn't know yet which dataset to resolve to
            // until a filter method tells it: `.is('resolved_at', ...)`
            // marks the first (unresolved-only) query, `.in('conversation_id', ...)`
            // marks the second (all-siblings) query. Mirrors the real
            // implementation's two distinct queries against the same
            // table.
            let dataset = intents
            const chain = {
              is: () => {
                dataset = intents
                return chain
              },
              in: () => {
                dataset = allIntents
                return chain
              },
              gte: () => chain,
              order: () => Promise.resolve({ data: dataset, error: null }),
              then: (
                resolve: (v: { data: Record<string, unknown>[]; error: null }) => void,
                reject?: (e: unknown) => void,
              ) => Promise.resolve({ data: dataset, error: null }).then(resolve, reject),
            }
            return chain
          },
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              state.updates.push({ payload, id })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === 'deals') {
        // Both `findMatchingMeetingLinkOnOpenDeal` (select meeting
        // fields, `.eq('status', 'open')`) and `contactHasOnlyClosedDeals`
        // (select id, `.eq('status', 'open')` then `.neq('status', 'open')`)
        // hit this same table -- track which filter was actually used
        // so each resolves against the right half of `dealsConfig`.
        let wantsOpen: boolean | null = null
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            if (col === 'status' && val === 'open') wantsOpen = true
            return chain
          },
          neq: (col: string, val: unknown) => {
            if (col === 'status' && val === 'open') wantsOpen = false
            return chain
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            if (wantsOpen === true) {
              return Promise.resolve({ data: dealsConfig.openDeal ?? null, error: null })
            }
            if (wantsOpen === false) {
              return Promise.resolve({
                data: dealsConfig.hasNonOpenDeal ? { id: 'closed-deal-1' } : null,
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          },
        }
        return chain
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
  h.scheduleMeetingReminders.mockReset()
  h.loadAiConfig.mockResolvedValue({ meetingEventLabel: null, businessHoursTimezone: 'America/Sao_Paulo', meetingRemindersEnabled: false })
})

describe('reconcileMeetingIntents', () => {
  it('retries an unresolved intent whose meeting time is still in the future', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: 'deal-1', reason: 'completed' })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1', intentId: 'intent-1' }),
    )
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 0 })
  })

  it('retries an intent up to 3h past its meeting time', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: 'deal-1', reason: 'completed' })
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
    expect(result).toEqual({ completed: 0, rescheduled: 1, stillPending: 0, superseded: 0, notApplicable: 0 })
  })

  it('counts an intent as still pending when ensureMeetingScheduled could not complete it (no_deal, transient -- keep retrying)', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false, dealId: null, reason: 'no_deal' })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 1, superseded: 0, notApplicable: 0 })
  })

  it('counts an intent as still pending when Calendar event creation failed (transient -- keep retrying)', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false, dealId: 'deal-1', reason: 'event_creation_failed' })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 1, superseded: 0, notApplicable: 0 })
  })

  // ------------------------------------------------------------
  // Critical fix: `no_stage` and `no_calendar` are permanent,
  // account-level gaps (no meeting_scheduled stage configured, or
  // Calendar never connected). Retrying tomorrow never fixes either,
  // and letting the intent live on until it crosses the 3h stale
  // threshold would eventually send the lead a wrong "let's
  // reschedule?" about a flow this account was never going to
  // complete. Both must close the intent out immediately as
  // `not_applicable`, with zero messages sent.
  // ------------------------------------------------------------
  it('closes the intent out as not_applicable immediately, with zero messages sent, when the pipeline has no meeting_scheduled stage', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false, dealId: null, reason: 'no_stage' })
    const { db, state } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'not_applicable' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 1 })
  })

  it('closes the intent out as not_applicable immediately, with zero messages sent, when the account has no Calendar connected', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false, dealId: 'deal-1', reason: 'no_calendar' })
    const { db, state } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'not_applicable' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 1 })
  })

  // ------------------------------------------------------------
  // Important #2: a human may have already closed out (won/lost) the
  // contact's deal while the intent sat unresolved (e.g. waiting on
  // Calendar to reconnect). Retrying must NOT create a brand-new
  // "WhatsApp Direto" deal and resurrect this lead's pipeline
  // presence -- close the intent out as not_applicable instead,
  // without ever calling ensureMeetingScheduled (so no deal creation,
  // no message).
  // ------------------------------------------------------------
  it('closes the intent out as not_applicable without creating a deal when the contact has only a closed (lost) deal, no open one', async () => {
    const { db, state } = makeDb([intent()], undefined, { openDeal: null, hasNonOpenDeal: true })
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'not_applicable' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 1 })
  })

  it('still retries normally when the contact has an open deal, regardless of any closed deal history', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: 'deal-1', reason: 'completed' })
    const { db } = makeDb([intent()], undefined, { openDeal: { id: 'open-deal-1' }, hasNonOpenDeal: true })
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledTimes(1)
    expect(result.completed).toBe(1)
  })

  // ------------------------------------------------------------
  // Important #1: a meeting completed only via this retroactive job
  // (not live) must still get its attendance reminders scheduled --
  // otherwise the lead who got rebooked by the daily retry never
  // gets the day-before/hour-before nudge a live booking would.
  // ------------------------------------------------------------
  it('schedules meeting reminders after a successful retry when meetingRemindersEnabled is on', async () => {
    h.loadAiConfig.mockResolvedValue({
      meetingEventLabel: null,
      businessHoursTimezone: 'America/Sao_Paulo',
      meetingRemindersEnabled: true,
    })
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: 'deal-1', reason: 'completed' })
    const { db } = makeDb([intent()])
    await reconcileMeetingIntents(db as never, NOW)
    expect(h.scheduleMeetingReminders).toHaveBeenCalledTimes(1)
    expect(h.scheduleMeetingReminders).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'acct-1',
        dealId: 'deal-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
      }),
    )
    const call = h.scheduleMeetingReminders.mock.calls[0][1]
    expect(call.meetingAt).toBeInstanceOf(Date)
    expect(call.meetingAt.toISOString()).toBe('2026-10-12T13:00:00.000Z')
  })

  it('does not schedule meeting reminders when meetingRemindersEnabled is off', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: 'deal-1', reason: 'completed' })
    const { db } = makeDb([intent()])
    await reconcileMeetingIntents(db as never, NOW)
    expect(h.scheduleMeetingReminders).not.toHaveBeenCalled()
  })

  it('does not schedule meeting reminders when completed but dealId is null', async () => {
    h.loadAiConfig.mockResolvedValue({
      meetingEventLabel: null,
      businessHoursTimezone: 'America/Sao_Paulo',
      meetingRemindersEnabled: true,
    })
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true, dealId: null, reason: 'completed' })
    const { db } = makeDb([intent()])
    await reconcileMeetingIntents(db as never, NOW)
    expect(h.scheduleMeetingReminders).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------
  // Safety check before ANY stale-reschedule message: the deal may
  // already have THIS exact meeting confirmed (a crash between the
  // Calendar event being created and the intent's own resolve-update
  // running). Telling an already-confirmed lead to reschedule would
  // be actively wrong.
  // ------------------------------------------------------------
  it('marks the intent completed with zero messages sent when the deal already has a matching meeting_link, even past the 3h stale threshold', async () => {
    const staleIntent = intent({ meeting_at: '2026-10-12T08:00:00.000Z' }) // 4h no passado
    const { db, state } = makeDb([staleIntent], undefined, {
      openDeal: { meeting_link: 'https://meet.google.com/already-confirmed', meeting_scheduled_at: '2026-10-12T08:00:00.000Z' },
    })
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'completed' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 0 })
  })

  it('still sends the stale-reschedule message when the deal has no matching meeting_link', async () => {
    h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
    const staleIntent = intent({ meeting_at: '2026-10-12T08:00:00.000Z' }) // 4h no passado
    const { db, state } = makeDb([staleIntent], undefined, { openDeal: null })
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'stale_rescheduled' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 1, stillPending: 0, superseded: 0, notApplicable: 0 })
  })

  it('skips an intent created less than 15 minutes ago, to not race a live in-flight attempt', async () => {
    const { db } = makeDb([intent({ created_at: '2026-10-12T11:50:00.000Z' })]) // 10min atrás
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 0, notApplicable: 0 })
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
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 1, notApplicable: 0 })
  })

  it('supersedes correctly by created_at even when the input array order is reversed', async () => {
    // Same fixture as above, but fed to the DB mock in [newer, older]
    // order -- a bug that just picked "the last array element" as
    // "newest" (instead of genuinely comparing created_at) would pick
    // intent-old here and fail this test.
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const older = intent({
      id: 'intent-old',
      created_at: '2026-10-12T09:00:00.000Z',
      meeting_at: '2026-10-12T10:00:00.000Z',
    })
    const newer = intent({
      id: 'intent-new',
      created_at: '2026-10-12T09:30:00.000Z',
      meeting_at: '2026-10-12T13:00:00.000Z',
    })
    const { db, state } = makeDb([newer, older])
    const result = await reconcileMeetingIntents(db as never, NOW)

    expect(h.ensureMeetingScheduled).toHaveBeenCalledTimes(1)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ intentId: 'intent-new' }),
    )
    const supersedeUpdate = state.updates.find((u) => u.id === 'intent-old')
    expect(supersedeUpdate).toMatchObject({ payload: { resolution: 'superseded' } })
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0, superseded: 1, notApplicable: 0 })
  })

  // ------------------------------------------------------------
  // The Critical gap this grouping is actually FOR: a stale older
  // intent (A) whose sibling (B) already succeeded and was marked
  // `resolution: 'completed'` -- B is therefore RESOLVED and never
  // shows up in the unresolved-only query. A on its own looks like a
  // lone "group of 1" and must still be recognized as superseded by
  // comparing against ALL intents for the conversation (resolved or
  // not), not just the unresolved ones.
  // ------------------------------------------------------------
  it('supersedes a lone unresolved intent when a resolved sibling for the same conversation is newer (still within retry window)', async () => {
    const olderUnresolved = intent({
      id: 'intent-old',
      created_at: '2026-10-12T09:00:00.000Z',
      meeting_at: '2026-10-12T10:00:00.000Z', // 2h no passado, dentro da janela de retry
    })
    const newerResolved = intent({
      id: 'intent-new',
      created_at: '2026-10-12T09:30:00.000Z', // mais nova que a intent-old
      meeting_at: '2026-10-12T11:00:00.000Z',
      resolved_at: '2026-10-12T11:05:00.000Z',
      resolution: 'completed',
    })
    // Query 1 (unresolved only) sees just the stale one. Query 2 (all
    // siblings) sees both -- that's what must catch this.
    const { db, state } = makeDb([olderUnresolved], [olderUnresolved, newerResolved])
    const result = await reconcileMeetingIntents(db as never, NOW)

    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    const supersedeUpdate = state.updates.find((u) => u.id === 'intent-old')
    expect(supersedeUpdate).toMatchObject({ payload: { resolution: 'superseded' } })
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 1, notApplicable: 0 })
  })

  it('supersedes a lone unresolved intent when a resolved sibling for the same conversation is newer (stale, >3h past meeting_at)', async () => {
    const olderUnresolved = intent({
      id: 'intent-old',
      created_at: '2026-10-12T09:00:00.000Z',
      meeting_at: '2026-10-12T08:00:00.000Z', // 4h no passado -- cairia no caminho stale_rescheduled
    })
    const newerResolved = intent({
      id: 'intent-new',
      created_at: '2026-10-12T09:30:00.000Z',
      meeting_at: '2026-10-12T11:00:00.000Z',
      resolved_at: '2026-10-12T11:05:00.000Z',
      resolution: 'completed',
    })
    const { db, state } = makeDb([olderUnresolved], [olderUnresolved, newerResolved])
    const result = await reconcileMeetingIntents(db as never, NOW)

    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled() // não manda "vamos reagendar?" -- já está resolvida
    const supersedeUpdate = state.updates.find((u) => u.id === 'intent-old')
    expect(supersedeUpdate).toMatchObject({ payload: { resolution: 'superseded' } })
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0, superseded: 1, notApplicable: 0 })
  })
})
