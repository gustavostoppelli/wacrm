import crypto from 'crypto'

/**
 * WhatsApp token encryption.
 *
 * Format — GCM (the only format; there is no legacy fallback):
 *   `<iv-hex>:<ciphertext-hex>:<authTag-hex>`      (three colons)
 *
 * Why GCM instead of CBC:
 *   CBC without a MAC is unauthenticated — an attacker who can write
 *   rows to `whatsapp_config` (directly, through a future RLS bug, or
 *   via a DB backup being modified) can flip bits in the ciphertext
 *   without the decrypt throwing. You'd silently get garbled tokens;
 *   worst case, if the mutated bytes happen to form a valid access
 *   token, messages go out under a spoofed account. GCM appends a
 *   16-byte authentication tag; any tampering fails the decrypt hard.
 *
 * This codebase briefly supported reading an older unauthenticated
 * CBC format for backward compatibility. It was removed (2026-08) once
 * confirmed no production `whatsapp_config` rows still used it — don't
 * reintroduce a CBC read path without re-auditing for live legacy rows
 * first.
 */

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!
// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv,
  )
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')

  if (parts.length !== 3) {
    throw new Error(
      `Encrypted token has unrecognised format (expected GCM's 3 colon-separated parts, got ${
        parts.length - 1
      })`,
    )
  }

  const [ivHex, ctHex, tagHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM IV length ${iv.length}`,
    )
  }
  const authTag = Buffer.from(tagHex, 'hex')
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`,
    )
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv,
  )
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(ctHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
