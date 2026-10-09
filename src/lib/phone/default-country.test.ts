import { describe, expect, it } from 'vitest'
import { getPhoneCountry, isSameCountry } from './default-country'

describe('default phone country', () => {
  it('falls back to Brazil for an unknown or missing country', () => {
    expect(getPhoneCountry(undefined).code).toBe('55')
    expect(getPhoneCountry('XX').code).toBe('55')
  })
  it('finds a country case-insensitively', () => {
    expect(getPhoneCountry('mx').code).toBe('52')
  })
  it('matches the checkout hint, including Brazil spellings', () => {
    expect(isSameCountry(getPhoneCountry('BR'), 'Brasil')).toBe(true)
    expect(isSameCountry(getPhoneCountry('MX'), 'mx')).toBe(true)
    expect(isSameCountry(getPhoneCountry('MX'), 'BR')).toBe(false)
  })
})
