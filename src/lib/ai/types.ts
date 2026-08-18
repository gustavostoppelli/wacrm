// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** When true, auto-reply only sends live within the window below —
   *  an off-hours inbound gets an immediate ack instead, and the real
   *  reply is deferred to the next window (see business-hours.ts). */
  businessHoursEnabled: boolean
  /** 0-23 inclusive. */
  businessHoursStart: number
  /** 1-24 exclusive (24 = "until midnight"). */
  businessHoursEnd: number
  /** IANA timezone the window above is evaluated in. */
  businessHoursTimezone: string
  /** Custom off-hours acknowledgement text; null uses the built-in
   *  default (see auto-reply.ts). */
  offHoursMessage: string | null
  /** When true (default), confirming a meeting via [[MEETING: ...]]
   *  also schedules day-before/hour-before attendance-confirmation
   *  reminders (migration 042). */
  meetingRemindersEnabled: boolean
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Free-text description of a meeting time the model says was just
   *  confirmed with the customer (e.g. "Tomorrow at 10am"), parsed
   *  from an inline [[MEETING: ...]] tag, or null when none was
   *  present this turn. */
  meetingNote: string | null
  /** ISO 8601 date-time for the same meeting, when the model could
   *  compute one; null when only a label was given (or no meeting tag
   *  was present). Reminders can only be scheduled when this is set. */
  meetingAt: string | null
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
