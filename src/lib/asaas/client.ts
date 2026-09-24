// ============================================================
// Minimal Asaas API client — just enough to look up a customer's
// contact info from a webhook's `payment.customer` id. Asaas webhook
// payloads never include customer phone/email directly (only the id),
// so this extra call is required. See docs.asaas.com/docs/webhook-para-cobrancas.
// ============================================================

const ASAAS_API_BASE = 'https://api.asaas.com/v3'

// Stored base64-encoded (ASAAS_API_KEY_B64), not as plain
// ASAAS_API_KEY — Asaas keys start with a literal "$", which Next.js's
// bundled env loader (@next/env) variable-expands even inside single
// quotes (unlike plain dotenv), silently producing an empty value.
// Base64 sidesteps that entirely; there's no secrecy benefit, only a
// parsing one.
function getAsaasApiKey(): string | undefined {
  const encoded = process.env.ASAAS_API_KEY_B64
  if (!encoded) return undefined
  return Buffer.from(encoded, 'base64').toString('utf8')
}

export interface AsaasCustomer {
  id: string
  name: string
  email: string | null
  phone: string | null
  mobilePhone: string | null
}

export async function getAsaasCustomer(customerId: string): Promise<AsaasCustomer> {
  const apiKey = getAsaasApiKey()
  if (!apiKey) {
    throw new Error('ASAAS_API_KEY_B64 is not configured')
  }

  const response = await fetch(`${ASAAS_API_BASE}/customers/${customerId}`, {
    headers: { access_token: apiKey },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Asaas API error fetching customer ${customerId}: ${response.status} ${text}`)
  }

  return response.json()
}
