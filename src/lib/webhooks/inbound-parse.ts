// ============================================================
// Inbound webhook payload parsing — no external platform is named in
// any user-facing string (Settings UI, automation variable names):
// the account names their own connection, and this module just
// recognizes a couple of common JSON shapes on the wire. Extending it
// to a new platform later is adding another shape check here, never a
// UI change — the connection itself has no "type" field to expand.
// ============================================================

export type InboundWebhookAction = 'open' | 'lost' | 'ignore'

export interface ParsedInboundWebhook {
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  dealTitle: string | null
  dealValue: number | null
  dealCurrency: string | null
  campaign: string | null
  action: InboundWebhookAction
  /** Flat string values only — matches the `{{ vars.x }}` interpolator
   *  in automations/engine.ts, which does not walk nested paths. */
  vars: Record<string, string>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}


/**
 * The checkout platform sends Brazilian buyers' phones WITHOUT the
 * country code (e.g. "34991623419" = DDD 34 + number). Stored as-is, the
 * WhatsApp API reads the leading "34" as Spain's country code and the
 * send fails. A bare 10-11 digit number (DDD + 8/9 digits) is therefore
 * completed with Brazil's "55".
 *
 * Left untouched: a leading "+", more than 11 digits (e.g. Colombia's
 * "573196345816"), and — when the payload names the buyer's country — any
 * country other than Brazil. That last guard matters because some foreign
 * numbers WITH their country code are also 11 digits (US/Canada, Spain,
 * Chile, Peru), which would otherwise be mistaken for DDD + number.
 */
export function normalizeBuyerPhone(
  phone: string | null,
  countryHint?: string | null,
): string | null {
  if (!phone) return phone
  if (phone.trim().startsWith('+')) return phone
  const country = (countryHint ?? '').trim().toUpperCase()
  if (country && !['BR', 'BRA', 'BRASIL', 'BRAZIL'].includes(country)) return phone
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  return phone
}

/** A well-known digital-product checkout/payment platform's webhook
 *  shape: `{ event, data: { buyer, product, purchase } }`. Recognized
 *  by structure, not by any account-visible label. */
function looksLikeCheckoutShape(body: AnyRecord): boolean {
  return typeof body?.event === 'string' && typeof body?.data === 'object' && body.data !== null
}

const CHECKOUT_OPEN_EVENTS = new Set([
  'PURCHASE_APPROVED',
  'PURCHASE_COMPLETE',
  'PURCHASE_BILLET_PRINTED',
  'PURCHASE_PIX_GENERATED',
  'PIX_GENERATED',
  'ABANDONED_CART',
  // Hotmart's real event name for cart abandonment (confirmed against
  // a live test payload 2026-10-01) — 'ABANDONED_CART' above was a
  // guess that never actually arrives on the wire; kept alongside in
  // case a different platform sends that name instead.
  'PURCHASE_OUT_OF_SHOPPING_CART',
])
const CHECKOUT_LOST_EVENTS = new Set([
  'PURCHASE_CANCELED',
  'PURCHASE_CANCELLED',
  'PURCHASE_REFUNDED',
  'PURCHASE_CHARGEBACK',
  // Hotmart's real event name for a chargeback/dispute ("pedido de
  // reembolso" contestado) — confirmed against a live test payload
  // 2026-10-01; 'PURCHASE_CHARGEBACK' above was an unconfirmed guess.
  'PURCHASE_PROTEST',
  'PURCHASE_EXPIRED',
  'PURCHASE_DELAYED',
])

function parseCheckoutShape(body: AnyRecord): ParsedInboundWebhook {
  const event = String(body.event)
  const data = body.data as AnyRecord
  const buyer = (data.buyer ?? data.customer ?? {}) as AnyRecord
  const product = (data.product ?? {}) as AnyRecord
  const purchase = (data.purchase ?? {}) as AnyRecord
  const price = (purchase.price ?? {}) as AnyRecord

  const name = asString(buyer.name)
  // Hotmart's buyer object carries first/last name separately from the
  // full `name` field (confirmed against a live payload 2026-10-01) —
  // exposed as its own `{{ vars.primeiro_nome }}` so a message can open
  // with just "Parabéns, Maria!" instead of the full legal name.
  const firstName = asString(buyer.first_name)
  const buyerCountry = asString(
    buyer.address?.country_iso ?? buyer.country_iso ?? buyer.address?.country ?? buyer.country,
  )
  const phone = normalizeBuyerPhone(asString(buyer.checkout_phone ?? buyer.phone), buyerCountry)
  const email = asString(buyer.email)
  const productName = asString(product.name)
  const value = asNumber(price.value ?? purchase.value)
  const currency = asString(price.currency_value ?? purchase.currency)

  const action: InboundWebhookAction = CHECKOUT_OPEN_EVENTS.has(event)
    ? 'open'
    : CHECKOUT_LOST_EVENTS.has(event)
      ? 'lost'
      : 'ignore'

  // TEMP diagnostic (remove after confirming Hotmart's real event
  // strings): log any event that doesn't match a known open/lost set,
  // so we can add it instead of guessing.
  if (action === 'ignore') {
    console.log('[inbound-webhook] unrecognized checkout event, treated as ignore:', event)
  }

  return {
    contactName: name,
    contactPhone: phone,
    contactEmail: email,
    dealTitle: productName ? `${productName}${name ? ` — ${name}` : ''}` : name,
    dealValue: value,
    dealCurrency: currency,
    campaign: productName,
    action,
    vars: {
      evento: event,
      nome: name ?? '',
      primeiro_nome: firstName ?? '',
      telefone: phone ?? '',
      email: email ?? '',
      produto: productName ?? '',
      valor: value !== null ? String(value) : '',
      moeda: currency ?? '',
    },
  }
}

/** Best-effort generic extraction for anything that doesn't match a
 *  recognized shape — looks for common field names (PT/EN) at the top
 *  level or under a nested contact-like object, so a customer's own
 *  form/tool can be pointed at this same URL without any code change. */
function parseGeneric(body: AnyRecord): ParsedInboundWebhook {
  const nested = (body.contact ?? body.buyer ?? body.customer ?? {}) as AnyRecord
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (body[k] !== undefined) return body[k]
      if (nested[k] !== undefined) return nested[k]
    }
    return undefined
  }

  const name = asString(pick('name', 'nome', 'full_name', 'nome_completo'))
  const firstName = asString(pick('first_name', 'primeiro_nome', 'nome_primeiro'))
  const phone = asString(pick('phone', 'telefone', 'celular', 'whatsapp', 'checkout_phone'))
  const email = asString(pick('email', 'e-mail'))
  const title = asString(pick('title', 'produto', 'product', 'product_name'))
  const value = asNumber(pick('value', 'valor', 'price', 'amount'))
  const currency = asString(pick('currency', 'moeda'))
  const event = asString(pick('event', 'evento', 'status'))

  return {
    contactName: name,
    contactPhone: phone,
    contactEmail: email,
    dealTitle: title ?? name,
    dealValue: value,
    dealCurrency: currency,
    campaign: title,
    action: 'open',
    vars: {
      evento: event ?? '',
      nome: name ?? '',
      primeiro_nome: firstName ?? '',
      telefone: phone ?? '',
      email: email ?? '',
      produto: title ?? '',
      valor: value !== null ? String(value) : '',
      moeda: currency ?? '',
    },
  }
}

export function parseInboundWebhookPayload(body: unknown): ParsedInboundWebhook {
  const record = (typeof body === 'object' && body !== null ? body : {}) as AnyRecord
  return looksLikeCheckoutShape(record) ? parseCheckoutShape(record) : parseGeneric(record)
}
