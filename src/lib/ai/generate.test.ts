import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    businessHoursEnabled: false,
    businessHoursStart: 0,
    businessHoursEnd: 24,
    businessHoursTimezone: 'UTC',
    offHoursMessage: null,
    meetingRemindersEnabled: false,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage,
    })
  })

  it('detects + strips a label-only meeting sentinel (no reminders schedulable)', () => {
    expect(
      parseGeneration('Perfeito, te vejo lá! [[MEETING: Tomorrow at 10am]]'),
    ).toEqual({
      text: 'Perfeito, te vejo lá!',
      handoff: false,
      meetingNote: 'Tomorrow at 10am',
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: null,
    })
  })

  it('parses an ISO + label meeting sentinel into meetingAt/meetingNote', () => {
    expect(
      parseGeneration(
        'Perfeito! [[MEETING: 2026-08-19T10:00:00-03:00 | Amanhã às 10h]]',
      ),
    ).toEqual({
      text: 'Perfeito!',
      handoff: false,
      meetingNote: 'Amanhã às 10h',
      meetingAt: new Date('2026-08-19T10:00:00-03:00').toISOString(),
      meetingEmail: null,
      notes: null,
      usage: null,
    })
  })

  it('meeting and handoff sentinels can both be present', () => {
    expect(
      parseGeneration(
        'Vou confirmar! [[MEETING: 2026-08-21T14:00:00-03:00 | Thursday 2pm]] [[HANDOFF]]',
      ),
    ).toEqual({
      text: 'Vou confirmar!',
      handoff: true,
      meetingNote: 'Thursday 2pm',
      meetingAt: new Date('2026-08-21T14:00:00-03:00').toISOString(),
      meetingEmail: null,
      notes: null,
      usage: null,
    })
  })

  it('parses the email when the meeting tag has all three parts', () => {
    const res = parseGeneration(
      'Confirmado! [[MEETING: 2026-08-19T10:00:00-03:00 | Amanhã às 10h | lead@example.com]]',
    )
    expect(res.meetingAt).toBe(new Date('2026-08-19T10:00:00-03:00').toISOString())
    expect(res.meetingNote).toBe('Amanhã às 10h')
    expect(res.meetingEmail).toBe('lead@example.com')
  })

  it('ignores a third part that is not a well-formed email', () => {
    const res = parseGeneration(
      '[[MEETING: 2026-08-19T10:00:00-03:00 | Amanhã às 10h | não sei o email]]',
    )
    expect(res.meetingEmail).toBeNull()
  })

  it('detects + strips a notes sentinel', () => {
    const res = parseGeneration(
      'Perfeito! [[NOTES: Função: Sócio\nGargalo: Leads desqualificados]]',
    )
    expect(res.text).toBe('Perfeito!')
    expect(res.notes).toBe('Função: Sócio\nGargalo: Leads desqualificados')
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      meetingNote: null,
      meetingAt: null,
      meetingEmail: null,
      notes: null,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
