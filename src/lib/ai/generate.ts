import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import {
  HANDOFF_SENTINEL,
  MEETING_SENTINEL_RE,
  NOTES_SENTINEL_RE,
  aiRequestTimeoutMs,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Split the raw model output into `{ text, handoff, meetingNote,
 * meetingAt, meetingEmail, notes, usage }`. The handoff sentinel can
 * appear alone or trailing a partial reply; either way we treat the
 * turn as a handoff and strip the marker from any remaining text.
 * `usage` is passed straight through (null when the provider didn't
 * report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  let text = raw.split(HANDOFF_SENTINEL).join('')

  const meetingMatch = text.match(MEETING_SENTINEL_RE)
  let meetingNote: string | null = null
  let meetingAt: string | null = null
  let meetingEmail: string | null = null
  if (meetingMatch) {
    const first = meetingMatch[1]?.trim() ?? ''
    const second = meetingMatch[2]?.trim() ?? ''
    const third = meetingMatch[3]?.trim() ?? ''
    const parsedFirst = second ? new Date(first) : null
    if (parsedFirst && !Number.isNaN(parsedFirst.getTime())) {
      meetingAt = parsedFirst.toISOString()
      meetingNote = second
      if (third && SIMPLE_EMAIL_RE.test(third)) meetingEmail = third
    } else {
      // Either no `|` (label-only shape) or the ISO part didn't parse
      // -- fall back to treating the whole capture as the label so a
      // malformed tag still moves the deal, just without reminders
      // (nothing to schedule them from) or a calendar event (nothing
      // to compute one for even if an email were present).
      meetingNote = (second ? `${first} ${second}` : first).trim() || null
    }
    text = text.replace(MEETING_SENTINEL_RE, '')
  }

  const notesMatch = text.match(NOTES_SENTINEL_RE)
  const notes = notesMatch ? notesMatch[1].trim() || null : null
  if (notesMatch) text = text.replace(NOTES_SENTINEL_RE, '')

  return {
    text: text.trim(),
    handoff,
    meetingNote,
    meetingAt,
    meetingEmail,
    notes,
    usage,
  }
}
