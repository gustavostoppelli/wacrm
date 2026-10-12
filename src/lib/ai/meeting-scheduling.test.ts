import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  findOpenDealForContact: vi.fn(),
  createEventForAccount: vi.fn(),
  engineSendText: vi.fn(),
}))
vi.mock('@/lib/deals/find-or-create-open-deal', () => ({ findOpenDealForContact: h.findOpenDealForContact }))
vi.mock('@/lib/calendar/google', () => ({ createEventForAccount: h.createEventForAccount }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

import { ensureMeetingScheduled } from './meeting-scheduling'

function makeDb(opts: {
  stageRow?: Record<string, unknown> | null
  contactRow?: Record<string, unknown> | null
  dealRow?: Record<string, unknown> | null
}) {
  const state = { dealUpdates: [] as Record<string, unknown>[], contactUpdates: [] as Record<string, unknown>[] }
  const db = {
    from: (table: string) => {
      if (table === 'pipeline_stages') {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: opts.stageRow ?? null, error: null }) }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.contactRow ?? null, error: null }) }) }),
          update: (p: Record<string, unknown>) => {
            state.contactUpdates.push(p)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'deals') {
        return {
          // ensureMeetingScheduled's own idempotency check
          // (meeting_link + meeting_scheduled_at already set) --
          // independent of the contacts/pipeline_stages lookups above.
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.dealRow ?? null, error: null }) }) }),
          update: (p: Record<string, unknown>) => {
            state.dealUpdates.push(p)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  meetingNote: 'Amanhã às 10h',
  meetingAt: '2026-10-12T13:00:00.000Z',
  meetingEmail: 'lead@example.com',
  meetingEventLabel: null,
  businessHoursTimezone: 'America/Sao_Paulo',
  intentId: null,
}

beforeEach(() => {
  h.findOpenDealForContact.mockReset()
  h.createEventForAccount.mockReset()
  h.engineSendText.mockReset()
  h.createEventForAccount.mockResolvedValue({ id: 'evt-1', meetLink: 'https://meet.google.com/x' })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('ensureMeetingScheduled', () => {
  it('returns completed:false, dealId:null without side effects when there is no deal (and none could be created)', async () => {
    h.findOpenDealForContact.mockResolvedValue(null)
    const { db } = makeDb({})
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: false, dealId: null })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
  })

  it('returns completed:false, dealId:null without side effects when the pipeline has no meeting_scheduled stage', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db } = makeDb({ stageRow: null })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: false, dealId: null })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
  })

  it('creates the Calendar event, moves the stage, and sends the link when nothing existed yet', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: null } })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: true, dealId: 'deal-1' })
    expect(state.dealUpdates[0]).toMatchObject({
      stage_id: 'stage-meeting',
      meeting_note: 'Amanhã às 10h',
      meeting_scheduled_at: ARGS.meetingAt,
      meeting_link: 'https://meet.google.com/x',
      calendar_event_id: 'evt-1',
    })
    expect(state.contactUpdates).toContainEqual({ email: 'lead@example.com' })
    const texts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(texts.some((t) => t.includes('https://meet.google.com/x'))).toBe(true)
  })

  it('does not overwrite an existing contact e-mail', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: 'already@example.com' } })
    await ensureMeetingScheduled(db as never, ARGS)
    expect(state.contactUpdates).toHaveLength(0)
  })

  it('returns completed:false, dealId set and never resends when the Calendar event creation fails', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    h.createEventForAccount.mockRejectedValue(new Error('calendar down'))
    const { db } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: 'x@example.com' } })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    // dealId is still set here: the stage WAS resolved and the deal's
    // stage/note fields WERE written, even though the Calendar event
    // itself failed -- callers that gate on dealId (e.g. reminder
    // scheduling) should still proceed, matching the pre-extraction
    // behavior where reminders didn't depend on event creation
    // succeeding.
    expect(result).toEqual({ completed: false, dealId: 'deal-1' })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('returns completed:true immediately, without recreating the Calendar event or resending any message, when the deal already has a meeting_link for this exact meetingAt', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({
      stageRow: { id: 'stage-meeting' },
      contactRow: { email: 'already@example.com' },
      dealRow: { meeting_link: 'https://meet.google.com/already-exists', meeting_scheduled_at: ARGS.meetingAt },
    })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: true, dealId: 'deal-1' })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.dealUpdates).toHaveLength(0)
    expect(state.contactUpdates).toHaveLength(0)
  })

  it('does NOT short-circuit -- creates a new event, updates the deal, and resends the link -- when the deal has a meeting_link but for a DIFFERENT meetingAt (a real reschedule)', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({
      stageRow: { id: 'stage-meeting' },
      contactRow: { email: 'already@example.com' },
      // Previously scheduled for a different time than ARGS.meetingAt.
      dealRow: { meeting_link: 'https://meet.google.com/old-time', meeting_scheduled_at: '2026-10-13T10:00:00.000Z' },
    })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: true, dealId: 'deal-1' })
    expect(h.createEventForAccount).toHaveBeenCalledTimes(1)
    expect(state.dealUpdates[0]).toMatchObject({
      stage_id: 'stage-meeting',
      meeting_scheduled_at: ARGS.meetingAt,
      meeting_link: 'https://meet.google.com/x',
      calendar_event_id: 'evt-1',
    })
    const texts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(texts.some((t) => t.includes('https://meet.google.com/x'))).toBe(true)
  })

  it('short-circuits on the same instant even when the stored meeting_scheduled_at is a Postgres-style offset string and meetingAt is a toISOString()-style one', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({
      stageRow: { id: 'stage-meeting' },
      contactRow: { email: 'already@example.com' },
      // Same instant as ARGS.meetingAt ('2026-10-12T13:00:00.000Z'),
      // but shaped the way PostgREST actually returns a timestamptz --
      // a raw "===" string comparison would wrongly treat these as
      // different and recreate the event / resend the link.
      dealRow: { meeting_link: 'https://meet.google.com/already-exists', meeting_scheduled_at: '2026-10-12T13:00:00+00:00' },
    })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: true, dealId: 'deal-1' })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(state.dealUpdates).toHaveLength(0)
    expect(state.contactUpdates).toHaveLength(0)
  })
})
