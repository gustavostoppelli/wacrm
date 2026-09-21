import { describe, expect, it } from 'vitest'
import { parseInboundWebhookPayload } from './inbound-parse'

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
