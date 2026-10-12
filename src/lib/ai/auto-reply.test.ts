import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  getSdrIaConfig: vi.fn(),
  resolvePipelineAndStage: vi.fn(),
  createEventForAccount: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    reactivationInserts: [] as Record<string, unknown>[],
    pendingReply: null as Record<string, unknown> | null,
    pendingReplyInsert: null as Record<string, unknown> | null,
    existingDeal: null as Record<string, unknown> | null,
    dealInserts: [] as Record<string, unknown>[],
    dealUpdates: [] as Record<string, unknown>[],
    contactRow: null as Record<string, unknown> | null,
    contactUpdates: [] as Record<string, unknown>[],
    createdDealId: 'new-deal-1',
    meetingStage: null as Record<string, unknown> | null,
    reminderInserts: [] as Record<string, unknown>[],
    reminderDeletes: 0,
    meetingIntentInserts: [] as Record<string, unknown>[],
    meetingIntentUpdates: [] as Record<string, unknown>[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/sdr-ia/config', () => ({ getSdrIaConfig: h.getSdrIaConfig }))
vi.mock('@/lib/api/v1/deals', () => ({ resolvePipelineAndStage: h.resolvePipelineAndStage }))
vi.mock('@/lib/calendar/google', () => ({ createEventForAccount: h.createEventForAccount }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'conversation_followups') {
        // dispatchInboundToAiReply unconditionally cancels any pending
        // nudge on every call, then (on a normal send) schedules a
        // fresh one -- not under test here, just needs to not throw.
        const chain = {
          delete: () => chain,
          insert: () => Promise.resolve({ data: null, error: null }),
          eq: () => Promise.resolve({ data: null, error: null }),
        }
        return chain
      }
      if (table === 'conversation_reactivations') {
        const chain = {
          delete: () => chain,
          insert: (payload: Record<string, unknown>) => {
            h.state.reactivationInserts.push(payload)
            return Promise.resolve({ data: null, error: null })
          },
          eq: () => Promise.resolve({ data: null, error: null }),
        }
        return chain
      }
      if (table === 'ai_pending_replies') {
        // .select().eq().eq().maybeSingle() → existing-pending lookup
        // .insert() → claim this off-hours wave
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.pendingReply, error: null }),
          insert: (payload: Record<string, unknown>) => {
            h.state.pendingReplyInsert = payload
            return Promise.resolve({ error: null })
          },
        }
        return chain
      }
      if (table === 'contacts') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.contactRow, error: null }),
          update: (payload: Record<string, unknown>) => {
            h.state.contactUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
        return chain
      }
      if (table === 'deals') {
        // .select().eq().eq().eq().order().limit().maybeSingle() →
        // findOpenDealForContact's existing-deal lookup.
        // .insert().select().single() → createDealForContact.
        // .update().eq() → conversation_id backfill or meeting fields.
        const selectChain = {
          select: () => selectChain,
          eq: () => selectChain,
          order: () => selectChain,
          limit: () => selectChain,
          maybeSingle: () => Promise.resolve({ data: h.state.existingDeal, error: null }),
        }
        const chain = {
          select: () => selectChain,
          insert: (payload: Record<string, unknown>) => {
            h.state.dealInserts.push(payload)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: h.state.createdDealId, pipeline_id: payload.pipeline_id, title: payload.title },
                    error: null,
                  }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            h.state.dealUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
        return chain
      }
      if (table === 'ai_meeting_intents') {
        const chain = {
          insert: (payload: Record<string, unknown>) => {
            h.state.meetingIntentInserts.push(payload)
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'intent-1' }, error: null }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            h.state.meetingIntentUpdates.push({ ...payload })
            return { eq: (_col: string, id: string) => {
              h.state.meetingIntentUpdates[h.state.meetingIntentUpdates.length - 1].id = id
              return Promise.resolve({ error: null })
            } }
          },
        }
        return chain
      }
      if (table === 'pipeline_stages') {
        // recordMeetingScheduled's own lookup of the meeting_scheduled stage.
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.meetingStage, error: null }),
        }
        return chain
      }
      if (table === 'deal_meeting_reminders') {
        // scheduleMeetingReminders: delete-then-insert the pending
        // day-before/hour-before rows for this deal.
        const chain = {
          delete: () => chain,
          eq: () => chain,
          is: () => {
            h.state.reminderDeletes += 1
            return Promise.resolve({ data: null, error: null })
          },
          insert: (payload: Record<string, unknown>[]) => {
            h.state.reminderInserts.push(...payload)
            return Promise.resolve({ data: null, error: null })
          },
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    // Off by default so the existing generate+send tests below aren't
    // affected by the business-hours gate; it has its own describe
    // block further down with enabled:true.
    businessHoursEnabled: false,
    businessHoursStart: 0,
    businessHoursEnd: 24,
    businessHoursTimezone: 'UTC',
    offHoursMessage: null,
    meetingRemindersEnabled: false,
    // Off by default -- the followup-scheduling tests set this
    // explicitly via overrides.
    followupEnabled: false,
    meetingEventLabel: null,
    reactivationEnabled: false,
    reactivationDays: 90,
    reactivationMessage: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.reactivationInserts = []
  h.state.pendingReply = null
  h.state.pendingReplyInsert = null
  h.state.existingDeal = null
  h.state.dealInserts = []
  h.state.dealUpdates = []
  h.state.contactRow = null
  h.state.contactUpdates = []
  h.state.createdDealId = 'new-deal-1'
  h.state.meetingStage = null
  h.state.reminderInserts = []
  h.state.reminderDeletes = 0
  h.state.meetingIntentInserts = []
  h.state.meetingIntentUpdates = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.getSdrIaConfig.mockResolvedValue(null)
  h.resolvePipelineAndStage.mockResolvedValue({ pipelineId: 'pipe-1', stageId: 'stage-default' })
  h.createEventForAccount.mockResolvedValue({ id: 'evt-1', meetLink: 'https://meet.google.com/test-link' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — business hours', () => {
  // Monday 02:00 UTC: a weekday, but before any sane startHour -- off-hours
  // for a 9-18 window regardless of local TZ quirks.
  const OFF_HOURS_NOW = new Date('2026-01-05T02:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(OFF_HOURS_NOW)
    h.loadAiConfig.mockResolvedValue(
      aiConfig({
        businessHoursEnabled: true,
        businessHoursStart: 9,
        businessHoursEnd: 18,
        businessHoursTimezone: 'UTC',
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers to a canned ack off-hours when the conversation is not from SDR IA', async () => {
    h.state.conv = { ...h.state.conv, whatsapp_config_id: 'chan-support' }
    h.getSdrIaConfig.mockResolvedValue(null)

    await dispatchInboundToAiReply(ARGS)

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.pendingReplyInsert).toEqual(
      expect.objectContaining({ conversation_id: 'conv-1' }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', aiGenerated: true }),
    )
  })

  it('replies for real, even off-hours, when the conversation is from SDR IA', async () => {
    h.state.conv = { ...h.state.conv, whatsapp_config_id: 'chan-sdr' }
    h.getSdrIaConfig.mockResolvedValue({ whatsappConfigId: 'chan-sdr' })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.pendingReplyInsert).toBeNull()
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('still defers when the conversation channel does not match the SDR IA channel', async () => {
    h.state.conv = { ...h.state.conv, whatsapp_config_id: 'chan-support' }
    h.getSdrIaConfig.mockResolvedValue({ whatsappConfigId: 'chan-sdr' })

    await dispatchInboundToAiReply(ARGS)

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.pendingReplyInsert).toEqual(
      expect.objectContaining({ conversation_id: 'conv-1' }),
    )
  })
})

// Regression: a contact who never got a deal created ahead of time
// (anyone messaging in directly instead of arriving via the Apify/
// Meta/site-form bridge -- an organic/CTWA reply, a manual test, a
// referral) always had the AI promise a meeting and then send
// NOTHING further: findOpenDealForContact returned null, and
// recordMeetingScheduled no-op'd immediately on that null, before
// moving the stage, creating the Calendar event, saving the e-mail,
// or sending the link follow-up. Caught live on 2026-10-10/11 -- the
// one test that "worked" (Luana) only did because a deal had been
// created for her by hand mid-conversation; a second live test
// (Julio) with no such deal reproduced the silent failure exactly.
describe('dispatchInboundToAiReply — meeting scheduling creates a missing deal', () => {
  function meetingReply(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      text: 'Perfeito! Confirmado pra amanhã às 10h.',
      handoff: false,
      meetingNote: 'Amanhã às 10h',
      meetingAt: '2026-10-12T10:00:00.000Z',
      meetingEmail: 'lead@example.com',
      ...overrides,
    }
  }

  it('creates a deal, moves its stage, creates the Calendar event, and sends the link when no deal existed for the contact', async () => {
    h.state.existingDeal = null
    h.state.contactRow = { name: 'Julio', phone: '5522998783605', email: null }
    h.state.meetingStage = { id: 'stage-meeting-scheduled' }
    h.generateReply.mockResolvedValue(meetingReply())

    await dispatchInboundToAiReply(ARGS)

    // The deal was created in the account's default pipeline/stage —
    // resolvePipelineAndStage with no name args, same as a deal made
    // by hand in the dashboard would land in.
    expect(h.resolvePipelineAndStage).toHaveBeenCalledWith(expect.anything(), 'acct-1')
    expect(h.state.dealInserts).toHaveLength(1)
    expect(h.state.dealInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-default',
      title: 'Julio',
      source: 'WhatsApp Direto',
      status: 'open',
    })

    // The deal just created is the one that gets its stage moved and
    // its meeting fields set.
    expect(h.state.dealUpdates).toHaveLength(1)
    expect(h.state.dealUpdates[0]).toMatchObject({
      stage_id: 'stage-meeting-scheduled',
      meeting_note: 'Amanhã às 10h',
      meeting_scheduled_at: '2026-10-12T10:00:00.000Z',
      meeting_link: 'https://meet.google.com/test-link',
      calendar_event_id: 'evt-1',
    })

    expect(h.createEventForAccount).toHaveBeenCalled()

    // The model's own reply has already been sent; the link comes as
    // a short follow-up once the event is actually created.
    const sentTexts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(sentTexts).toContain('Aqui está o link da nossa reunião: https://meet.google.com/test-link')
  })

  it('saves the meeting e-mail onto the newly-created contact when it had none', async () => {
    h.state.existingDeal = null
    h.state.contactRow = { name: 'Julio', phone: '5522998783605', email: null }
    h.state.meetingStage = { id: 'stage-meeting-scheduled' }
    h.generateReply.mockResolvedValue(meetingReply({ meetingEmail: 'julio@example.com' }))

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.contactUpdates).toContainEqual({ email: 'julio@example.com' })
  })

  it('does not create a second deal when one already exists for the contact', async () => {
    h.state.existingDeal = { id: 'deal-existing', pipeline_id: 'pipe-1', title: 'Julio', conversation_id: 'conv-1' }
    h.state.meetingStage = { id: 'stage-meeting-scheduled' }
    h.generateReply.mockResolvedValue(meetingReply())

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.dealInserts).toHaveLength(0)
    expect(h.state.dealUpdates).toHaveLength(1)
    expect(h.createEventForAccount).toHaveBeenCalled()
  })

  it('does not block the reply or throw when deal creation itself fails', async () => {
    h.state.existingDeal = null
    h.resolvePipelineAndStage.mockRejectedValue(new Error('no pipelines configured yet'))
    h.generateReply.mockResolvedValue(meetingReply())

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: meetingReply().text }),
    )
    expect(h.state.dealInserts).toHaveLength(0)
    expect(h.createEventForAccount).not.toHaveBeenCalled()
  })

  // Rescheduling is a real, live feature (the model re-emits the
  // meeting tag both to confirm AND to move an existing meeting to a
  // new time -- see defaults.ts's system prompt and the reminder
  // cron's "offer a new time and reschedule" flow). The idempotency
  // guard in ensureMeetingScheduled must never swallow this: a
  // different meetingAt than what's already stored has to fall
  // through to the normal create/update/send path again.
  it('reschedules: creates a new Calendar event and resends the link when the deal already has a meeting_link for a DIFFERENT time', async () => {
    h.state.existingDeal = {
      id: 'deal-existing',
      pipeline_id: 'pipe-1',
      title: 'Julio',
      conversation_id: 'conv-1',
      meeting_link: 'https://meet.google.com/old-time',
      meeting_scheduled_at: '2026-10-11T10:00:00.000Z',
    }
    h.state.meetingStage = { id: 'stage-meeting-scheduled' }
    h.generateReply.mockResolvedValue(meetingReply({ meetingAt: '2026-10-12T10:00:00.000Z' }))

    await dispatchInboundToAiReply(ARGS)

    expect(h.createEventForAccount).toHaveBeenCalledTimes(1)
    expect(h.state.dealUpdates).toHaveLength(1)
    expect(h.state.dealUpdates[0]).toMatchObject({
      meeting_scheduled_at: '2026-10-12T10:00:00.000Z',
      meeting_link: 'https://meet.google.com/test-link',
    })
    const sentTexts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(sentTexts).toContain('Aqui está o link da nossa reunião: https://meet.google.com/test-link')
  })

  // Critical: the pre-extraction code had `if (!stage) return` BEFORE
  // the reminders block, so an account with no meeting_scheduled
  // stage configured never got reminders scheduled against a deal
  // whose meeting fields were never written. Reminders must stay
  // gated the same way after the extraction, even though the stage
  // lookup now happens inside ensureMeetingScheduled rather than
  // inline in recordMeetingScheduled.
  it('does not schedule reminders when the account has no meeting_scheduled stage configured, even with reminders enabled', async () => {
    h.state.existingDeal = { id: 'deal-existing', pipeline_id: 'pipe-1', title: 'Julio', conversation_id: 'conv-1' }
    h.state.meetingStage = null
    h.loadAiConfig.mockResolvedValue(aiConfig({ meetingRemindersEnabled: true }))
    h.generateReply.mockResolvedValue(meetingReply())

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.dealUpdates).toHaveLength(0)
    expect(h.state.reminderInserts).toHaveLength(0)
    expect(h.state.reminderDeletes).toBe(0)
  })

  it('records an ai_meeting_intents row before attempting any side effect, and marks it completed on success', async () => {
    h.state.existingDeal = null
    h.state.contactRow = { name: 'Julio', phone: '5522998783605', email: null }
    h.state.meetingStage = { id: 'stage-meeting-scheduled' }
    h.generateReply.mockResolvedValue(meetingReply())

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.meetingIntentInserts).toHaveLength(1)
    expect(h.state.meetingIntentInserts[0]).toMatchObject({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      config_owner_user_id: 'user-1',
      meeting_at: meetingReply().meetingAt,
      meeting_email: meetingReply().meetingEmail,
      meeting_note: meetingReply().meetingNote,
    })
    expect(h.state.meetingIntentUpdates).toHaveLength(1)
    expect(h.state.meetingIntentUpdates[0]).toMatchObject({
      id: 'intent-1',
      resolution: 'completed',
    })
  })

  it('leaves the intent unresolved (does not mark it completed) when the deal cannot be created', async () => {
    h.state.existingDeal = null
    h.resolvePipelineAndStage.mockRejectedValue(new Error('no pipelines yet'))
    h.generateReply.mockResolvedValue(meetingReply())

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.meetingIntentInserts).toHaveLength(1)
    expect(h.state.meetingIntentUpdates).toHaveLength(0)
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — reactivation', () => {
  it('schedules a reactivation when the reply includes reactivateAt', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Combinado!',
      handoff: false,
      reactivateAt: '2026-10-03T15:00:00.000Z',
      reactivateReason: 'Gatekeeper pediu pra ligar às 15h',
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.reactivationInserts).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        config_owner_user_id: 'user-1',
        send_at: '2026-10-03T15:00:00.000Z',
        reason: 'Gatekeeper pediu pra ligar às 15h',
      }),
    ])
  })

  it('does not schedule a reactivation when the reply has no reactivateAt', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.reactivationInserts).toHaveLength(0)
  })
})
