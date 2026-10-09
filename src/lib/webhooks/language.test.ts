import { describe, expect, it } from 'vitest'
import { detectLeadLanguage } from './language'

describe('detectLeadLanguage', () => {
  it('Brazilian and Portuguese numbers are Portuguese', () => {
    expect(detectLeadLanguage({ phone: '5511999998888' })).toBe('pt')
    expect(detectLeadLanguage({ phone: '351912345678' })).toBe('pt')
  })

  it('Spanish-speaking calling codes are Spanish', () => {
    expect(detectLeadLanguage({ phone: '34612345678' })).toBe('es')
    expect(detectLeadLanguage({ phone: '5491145678901' })).toBe('es') // Argentina
    expect(detectLeadLanguage({ phone: '573196345816' })).toBe('es') // Colombia
    expect(detectLeadLanguage({ phone: '593987654321' })).toBe('es') // Ecuador
    expect(detectLeadLanguage({ phone: '+52 55 1234 5678' })).toBe('es') // Mexico
  })

  it('Puerto Rico / Dominican Rep. (+1) are Spanish, other +1 follow the country', () => {
    expect(detectLeadLanguage({ phone: '17875551234' })).toBe('es')
    expect(detectLeadLanguage({ phone: '18095551234' })).toBe('es')
    expect(detectLeadLanguage({ phone: '14155550123' })).toBe('pt')
    expect(detectLeadLanguage({ phone: '14155550123', countryIso: 'ES' })).toBe('es')
  })

  it('a Brazilian number stays Portuguese even if the checkout says Spain', () => {
    expect(detectLeadLanguage({ phone: '5511999998888', countryIso: 'ES' })).toBe('pt')
  })

  it('falls back to the checkout country, then to Portuguese', () => {
    expect(detectLeadLanguage({ phone: null, countryIso: 'mx' })).toBe('es')
    expect(detectLeadLanguage({ phone: '4915112345678', countryIso: 'DE' })).toBe('pt')
    expect(detectLeadLanguage({})).toBe('pt')
  })
})
