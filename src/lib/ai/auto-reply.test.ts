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
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    reactivationInserts: [] as Record<string, unknown>[],
    pendingReply: null as Record<string, unknown> | null,
    pendingReplyInsert: null as Record<string, unknown> | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/sdr-ia/config', () => ({ getSdrIaConfig: h.getSdrIaConfig }))
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
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.getSdrIaConfig.mockResolvedValue(null)
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
