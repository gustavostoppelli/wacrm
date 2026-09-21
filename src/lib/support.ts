// ============================================================
// FuseHub's own support contact — the platform vendor's channel,
// same for every account regardless of tenant. Not a per-customer
// setting (unlike accounts.whatsapp_channel_limit etc.): every
// customer of the sellable product reaches the same support line,
// the way any SaaS product's own "contact support" link works.
// ============================================================

const SUPPORT_PHONE = '5521973241568'

export function supportWhatsAppUrl(message: string): string {
  return `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(message)}`
}
