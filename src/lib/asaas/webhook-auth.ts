// ============================================================
// Asaas webhook authentication.
//
// Unlike inbound_webhooks/api_keys (per-row hashed tokens), this is a
// single static secret shared with Asaas: it's configured once in the
// Asaas dashboard's webhook settings ("Auth Token" field) and Asaas
// echoes it back on every request via the `asaas-access-token` header.
// See docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook.
// ============================================================

import { timingSafeEqual } from 'node:crypto'

export function isValidAsaasWebhookToken(headerValue: string | null): boolean {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN
  if (!expected || !headerValue) return false

  const a = Buffer.from(headerValue)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
