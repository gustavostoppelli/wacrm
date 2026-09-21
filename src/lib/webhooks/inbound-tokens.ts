// ============================================================
// Inbound webhook token generation + hashing — pure, server-side.
//
// Mirrors src/lib/api-keys/keys.ts exactly: the DB stores only the
// SHA-256 hash (inbound_webhooks.token_hash), the plaintext is shown
// to the creator exactly once, folded into the connection's URL as
// `?token=`. See migration 066 for the rationale.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface GeneratedInboundWebhookToken {
  /** Plaintext token — return to the creator ONCE, never persist. */
  plaintext: string
  /** SHA-256 hex digest. Persist this in inbound_webhooks.token_hash. */
  hash: string
}

export function generateInboundWebhookToken(): GeneratedInboundWebhookToken {
  // 32 bytes of CSPRNG entropy, base64url so it's safe unescaped in a
  // query string.
  const plaintext = randomBytes(32).toString('base64url')
  return { plaintext, hash: hashInboundWebhookToken(plaintext) }
}

export function hashInboundWebhookToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

/** Constant-time comparison of two hex digests — see api-keys/keys.ts's
 *  timingSafeHexEqual for the same rationale. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
