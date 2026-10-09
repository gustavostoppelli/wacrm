// ============================================================
// Language of a lead (pt / es), inferred from the phone's country
// code and, failing that, the country the checkout reported.
//
// Why not "not +55 => Spanish": Portugal (+351) alone is a big share of
// the non-Brazilian contacts of a Brazilian infoproduct, and they speak
// Portuguese. So Spanish is decided from a list of Spanish-speaking
// countries, never by exclusion. Anything unknown is Portuguese.
// ============================================================

export type LeadLanguage = 'pt' | 'es'

/** Calling codes of Spanish-speaking countries (longest match wins). */
const ES_CALLING_CODES = [
  '34', // Spain
  '51', // Peru
  '52', // Mexico
  '53', // Cuba
  '54', // Argentina
  '56', // Chile
  '57', // Colombia
  '58', // Venezuela
  '240', // Equatorial Guinea
  '502', // Guatemala
  '503', // El Salvador
  '504', // Honduras
  '505', // Nicaragua
  '506', // Costa Rica
  '507', // Panama
  '591', // Bolivia
  '593', // Ecuador
  '595', // Paraguay
  '598', // Uruguay
]

/** NANP (+1) area codes of Spanish-speaking territories. */
const ES_NANP_AREA_CODES = ['787', '939', '809', '829', '849'] // Puerto Rico, Dominican Rep.

/** Calling codes of Portuguese-speaking countries (decide "pt" outright). */
const PT_CALLING_CODES = ['55', '351', '244', '258', '238', '245', '239', '670', '853']

const ES_COUNTRY_ISO = new Set([
  'ES', 'MX', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'BO', 'PY', 'UY',
  'CR', 'PA', 'GT', 'HN', 'SV', 'NI', 'CU', 'DO', 'PR', 'GQ',
])

function languageFromPhone(phone: string | null | undefined): LeadLanguage | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('1') && digits.length === 11) {
    return ES_NANP_AREA_CODES.includes(digits.slice(1, 4)) ? 'es' : null
  }
  // Longest codes first so +351 is never read as something shorter.
  const match = (list: string[]) =>
    list.some((code) => digits.startsWith(code))
  if (match(PT_CALLING_CODES)) return 'pt'
  if (match(ES_CALLING_CODES)) return 'es'
  return null
}

/**
 * Decide the language of a lead. Order: the phone's country code (the
 * number the message will actually go to), then the checkout's country,
 * then Portuguese.
 */
export function detectLeadLanguage(input: {
  phone?: string | null
  countryIso?: string | null
}): LeadLanguage {
  const fromPhone = languageFromPhone(input.phone)
  if (fromPhone) return fromPhone
  const iso = (input.countryIso ?? '').trim().toUpperCase()
  if (ES_COUNTRY_ISO.has(iso)) return 'es'
  return 'pt'
}
