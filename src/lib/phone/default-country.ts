// ============================================================
// Default country for phone numbers that arrive without a country code.
//
// `lengths` are the possible digit counts of the NATIONAL number (area
// code included, no leading 0). A bare number of one of those lengths is
// completed with `code`; anything else is left alone, because a number
// that is longer, or starts with "+", already carries its own country.
// ============================================================

export interface PhoneCountry {
  iso: string
  /** Name shown in settings (pt-BR). */
  label: string
  code: string
  lengths: number[]
}

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso: 'BR', label: 'Brasil (+55)', code: '55', lengths: [10, 11] },
  { iso: 'PT', label: 'Portugal (+351)', code: '351', lengths: [9] },
  { iso: 'ES', label: 'Espanha (+34)', code: '34', lengths: [9] },
  { iso: 'MX', label: 'México (+52)', code: '52', lengths: [10] },
  { iso: 'AR', label: 'Argentina (+54)', code: '54', lengths: [10] },
  { iso: 'CO', label: 'Colômbia (+57)', code: '57', lengths: [10] },
  { iso: 'CL', label: 'Chile (+56)', code: '56', lengths: [9] },
  { iso: 'PE', label: 'Peru (+51)', code: '51', lengths: [9] },
  { iso: 'EC', label: 'Equador (+593)', code: '593', lengths: [9] },
  { iso: 'PY', label: 'Paraguai (+595)', code: '595', lengths: [9] },
  { iso: 'UY', label: 'Uruguai (+598)', code: '598', lengths: [8] },
  { iso: 'US', label: 'Estados Unidos / Canadá (+1)', code: '1', lengths: [10] },
]

export const DEFAULT_PHONE_COUNTRY = 'BR'

/** Extra spellings a checkout may use for the same country. */
const ALIASES: Record<string, string[]> = {
  BR: ['BR', 'BRA', 'BRASIL', 'BRAZIL'],
}

export function getPhoneCountry(iso: string | null | undefined): PhoneCountry {
  const key = (iso ?? '').trim().toUpperCase()
  return (
    PHONE_COUNTRIES.find((c) => c.iso === key) ??
    PHONE_COUNTRIES.find((c) => c.iso === DEFAULT_PHONE_COUNTRY)!
  )
}

/** True when the checkout's reported country is the account's default country. */
export function isSameCountry(country: PhoneCountry, hint: string): boolean {
  const h = hint.trim().toUpperCase()
  return (ALIASES[country.iso] ?? [country.iso]).includes(h)
}
