// ============================================================
// Signup-invitation token generation — pure, server-side.
//
// Mirrors src/lib/webhooks/inbound-tokens.ts exactly: only the SHA-256
// hash is ever persisted (signup_invitations.token_hash, migration
// 068), the plaintext is generated and handed to the recipient once.
// Shared by scripts/generate-signup-link.js's manual flow (duplicated
// there since that script runs standalone outside the Next.js app)
// and the automatic Asaas-webhook flow (src/app/api/webhooks/asaas).
// ============================================================

import { createHash, randomBytes } from 'node:crypto'

export interface GeneratedSignupToken {
  /** Plaintext token — hand to the recipient once, never persist. */
  plaintext: string
  /** SHA-256 hex digest. Persist this in signup_invitations.token_hash. */
  hash: string
}

export function generateSignupToken(): GeneratedSignupToken {
  const plaintext = randomBytes(32).toString('base64url')
  return { plaintext, hash: hashSignupToken(plaintext) }
}

export function hashSignupToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}
