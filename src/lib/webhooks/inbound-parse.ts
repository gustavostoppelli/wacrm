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
])
const CHECKOUT_LOST_EVENTS = new Set([
  'PURCHASE_CANCELED',
  'PURCHASE_CANCELLED',
  'PURCHASE_REFUNDED',
  'PURCHASE_CHARGEBACK',
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
  const phone = asString(buyer.checkout_phone ?? buyer.phone)
  const email = asString(buyer.email)
  const productName = asString(product.name)
  const value = asNumber(price.value ?? purchase.value)
  const currency = asString(price.currency_value ?? purchase.currency)

  const action: InboundWebhookAction = CHECKOUT_OPEN_EVENTS.has(event)
    ? 'open'
    : CHECKOUT_LOST_EVENTS.has(event)
      ? 'lost'
      : 'ignore'

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
