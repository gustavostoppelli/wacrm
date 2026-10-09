import { describe, expect, it } from 'vitest'
import { firstWordOf, normalizeBuyerPhone, parseInboundWebhookPayload } from './inbound-parse'

describe('parseInboundWebhookPayload', () => {
  it('parses a recognized checkout-platform PURCHASE_APPROVED payload as an open deal', () => {
    const result = parseInboundWebhookPayload({
      event: 'PURCHASE_APPROVED',
      data: {
        buyer: { name: 'Jane Doe', email: 'jane@example.com', checkout_phone: '+55 (21) 99999-9999' },
        product: { name: 'Curso X' },
        purchase: { price: { value: 197, currency_value: 'BRL' } },
      },
    })

    expect(result.action).toBe('open')
    expect(result.contactName).toBe('Jane Doe')
    expect(result.contactPhone).toBe('+55 (21) 99999-9999')
    expect(result.contactEmail).toBe('jane@example.com')
    expect(result.dealTitle).toBe('Curso X — Jane Doe')
    expect(result.dealValue).toBe(197)
    expect(result.dealCurrency).toBe('BRL')
    expect(result.campaign).toBe('Curso X')
    expect(result.vars).toMatchObject({
      evento: 'PURCHASE_APPROVED',
      nome: 'Jane Doe',
      produto: 'Curso X',
      valor: '197',
      moeda: 'BRL',
    })
  })

  it('marks a refund/cancellation event as lost', () => {
    const result = parseInboundWebhookPayload({
      event: 'PURCHASE_REFUNDED',
      data: { buyer: { name: 'Jane Doe', checkout_phone: '5521999999999' }, product: {}, purchase: {} },
    })
    expect(result.action).toBe('lost')
  })

  it('treats an abandoned-cart event as open (recoverable lead)', () => {
    const result = parseInboundWebhookPayload({
      event: 'ABANDONED_CART',
      data: { buyer: { name: 'Jane Doe', checkout_phone: '5521999999999' }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(result.action).toBe('open')
  })

  it('ignores an unrecognized checkout event but still returns usable vars', () => {
    const result = parseInboundWebhookPayload({
      event: 'SOME_FUTURE_EVENT',
      data: { buyer: { name: 'Jane Doe' }, product: {}, purchase: {} },
    })
    expect(result.action).toBe('ignore')
    expect(result.vars.evento).toBe('SOME_FUTURE_EVENT')
  })

  it('falls back to generic field extraction for a custom/unknown shape', () => {
    const result = parseInboundWebhookPayload({
      nome: 'Maria Silva',
      telefone: '5511988887777',
      email: 'maria@example.com',
      produto: 'Consultoria',
      valor: 500,
    })
    expect(result.action).toBe('open')
    expect(result.contactName).toBe('Maria Silva')
    expect(result.contactPhone).toBe('5511988887777')
    expect(result.dealValue).toBe(500)
    expect(result.campaign).toBe('Consultoria')
  })

  it('extracts generic fields from a nested contact/buyer/customer object', () => {
    const result = parseInboundWebhookPayload({
      contact: { name: 'Ana', phone: '5521988776655' },
      title: 'Plano Anual',
    })
    expect(result.contactName).toBe('Ana')
    expect(result.contactPhone).toBe('5521988776655')
    expect(result.dealTitle).toBe('Plano Anual')
  })

  it('handles an empty/malformed body without throwing', () => {
    const result = parseInboundWebhookPayload(null)
    expect(result.action).toBe('open')
    expect(result.contactPhone).toBeNull()
  })
})

describe('normalizeBuyerPhone', () => {
  it('adds the Brazilian 55 to a bare DDD + number (10 or 11 digits)', () => {
    expect(normalizeBuyerPhone('34991623419')).toBe('5534991623419')
    expect(normalizeBuyerPhone('(34) 3123-4567')).toBe('553431234567')
    // DDD 55 (Santa Maria/RS) with 11 digits is still a bare BR number.
    expect(normalizeBuyerPhone('55991234567')).toBe('5555991234567')
  })

  it('leaves numbers that already carry a country code untouched', () => {
    expect(normalizeBuyerPhone('5534991623419')).toBe('5534991623419')
    expect(normalizeBuyerPhone('573196345816')).toBe('573196345816')
    expect(normalizeBuyerPhone('+34 612 345 678')).toBe('+34 612 345 678')
    expect(normalizeBuyerPhone(null)).toBeNull()
  })

  it('does not touch a number when the buyer country is not Brazil', () => {
    // 11 digits WITH country code (US, Spain, Chile, Peru) must not get a 55.
    expect(normalizeBuyerPhone('12125551234', 'US')).toBe('12125551234')
    expect(normalizeBuyerPhone('34612345678', 'ES')).toBe('34612345678')
    expect(normalizeBuyerPhone('34991623419', 'BR')).toBe('5534991623419')
    expect(normalizeBuyerPhone('34991623419', 'br')).toBe('5534991623419')
  })

  it('reads the country from the checkout payload buyer address', () => {
    const foreign = parseInboundWebhookPayload({
      event: 'PURCHASE_APPROVED',
      data: { buyer: { name: 'John', checkout_phone: '12125551234', address: { country_iso: 'US' } }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(foreign.contactPhone).toBe('12125551234')
    const brazilian = parseInboundWebhookPayload({
      event: 'PURCHASE_APPROVED',
      data: { buyer: { name: 'Ana', checkout_phone: '34991623419', address: { country_iso: 'BR' } }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(brazilian.contactPhone).toBe('5534991623419')
  })

  it('is applied to the buyer phone of a checkout payload', () => {
    const result = parseInboundWebhookPayload({
      event: 'PURCHASE_APPROVED',
      data: { buyer: { name: 'Luciana', checkout_phone: '34991623419' }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(result.contactPhone).toBe('5534991623419')
    expect(result.vars.telefone).toBe('5534991623419')
  })
})

describe('primeiro_nome fallback', () => {
  it('takes the first word of the full name when no first_name is sent (abandoned cart)', () => {
    const result = parseInboundWebhookPayload({
      event: 'PURCHASE_OUT_OF_SHOPPING_CART',
      data: { buyer: { name: 'Carmen Zapata', email: 'c@example.com', phone: '573196345816' }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(result.vars.primeiro_nome).toBe('Carmen')
  })

  it('keeps the explicit first_name when the sender provides one', () => {
    const result = parseInboundWebhookPayload({
      event: 'PURCHASE_APPROVED',
      data: { buyer: { name: 'Maria da Silva', first_name: 'Maria Clara', checkout_phone: '5521999999999' }, product: { name: 'Curso X' }, purchase: {} },
    })
    expect(result.vars.primeiro_nome).toBe('Maria Clara')
  })

  it('is empty only when there is no name at all', () => {
    expect(firstWordOf('  ')).toBeNull()
    expect(firstWordOf(null)).toBeNull()
    expect(firstWordOf('  Ana  Paula ')).toBe('Ana')
  })
})

describe('normalizeBuyerPhone — account default country', () => {
  it('keeps Brazil as the default', () => {
    expect(normalizeBuyerPhone('34991623419', null, undefined)).toBe('5534991623419')
    expect(normalizeBuyerPhone('34991623419', null, 'BR')).toBe('5534991623419')
  })

  it('completes with the account country code instead of 55', () => {
    expect(normalizeBuyerPhone('5512345678', null, 'MX')).toBe('525512345678')
    expect(normalizeBuyerPhone('612345678', null, 'ES')).toBe('34612345678')
    expect(normalizeBuyerPhone('912345678', null, 'PT')).toBe('351912345678')
  })

  it('does not touch numbers whose length does not fit the default country', () => {
    // 11 digits is not a Mexican national number
    expect(normalizeBuyerPhone('34991623419', null, 'MX')).toBe('34991623419')
  })

  it('a checkout country different from the account default wins', () => {
    expect(normalizeBuyerPhone('5512345678', 'BR', 'MX')).toBe('5512345678')
    expect(normalizeBuyerPhone('5512345678', 'MX', 'MX')).toBe('525512345678')
  })

  it('parseInboundWebhookPayload threads the default country through', () => {
    const r = parseInboundWebhookPayload(
      { event: 'PURCHASE_APPROVED', data: { buyer: { name: 'Ana', checkout_phone: '5512345678' } } },
      { defaultCountry: 'MX' },
    )
    expect(r.contactPhone).toBe('525512345678')
  })
})
