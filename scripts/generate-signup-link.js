#!/usr/bin/env node
// ============================================================
// Generates a single-use signup link (migration 068) for a new
// paying customer. Run manually whenever a sale closes — there's no
// admin UI for this yet (low volume so far; see AGENTS.md-style
// reasoning in the migration's comment for why that's an intentional,
// revisitable choice).
//
// Usage:
//   node scripts/generate-signup-link.js "Nome do cliente" [dias_de_validade]
//
// Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// (optionally) NEXT_PUBLIC_APP_URL in the environment — same vars the
// app itself uses, so running this via `node -r dotenv/config` against
// .env.local (or on the VPS where they're already exported) both work.
// ============================================================

const crypto = require('crypto')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://fusehub.fusegrowth.com.br'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}

const label = process.argv[2]
const expiresInDays = Number(process.argv[3]) || 14

if (!label) {
  console.error('Usage: node scripts/generate-signup-link.js "Nome do cliente" [dias_de_validade]')
  process.exit(1)
}

function generateToken() {
  const plaintext = crypto.randomBytes(32).toString('base64url')
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex')
  return { plaintext, hash }
}

async function main() {
  const { plaintext, hash } = generateToken()
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()

  const res = await fetch(`${SUPABASE_URL}/rest/v1/signup_invitations`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ token_hash: hash, label, expires_at: expiresAt }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`Failed to create signup invitation: ${res.status} ${text}`)
    process.exit(1)
  }

  const url = `${APP_URL}/signup?signup_token=${plaintext}`
  console.log('\nLink de cadastro gerado:')
  console.log(url)
  console.log(`\nVálido até: ${expiresAt}`)
  console.log('Uso único — expira automaticamente após o primeiro cadastro bem-sucedido.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
