// ============================================================
// Fuse's own sales-automation config — internal to Fuse's own
// operation of selling FuseHub itself, not a per-tenant customer
// feature (same rationale as src/lib/support.ts's SUPPORT_PHONE:
// every customer of the sellable product is unaffected by this,
// it's Fuse's own account acting as its own first customer/operator).
//
// FUSE_SALES_WHATSAPP_CHANNEL_ID currently points at the "Automação
// leads 1" channel (5521973241568). Gustavo mentioned a dedicated
// number may replace it later — when that happens, only this file
// needs to change.
// ============================================================

export const FUSE_ACCOUNT_ID = '7c26ec4e-39c6-4ce9-a611-ad694ce1d328'
export const FUSE_SALES_WHATSAPP_CHANNEL_ID = 'b9ab7ad5-f263-4ef2-8b78-2c615deb6086'

export interface FusePlan {
  /** Monthly value in BRL, as charged on the Asaas payment link. */
  value: number
  label: string
}

// The 3 recurring payment links created in Asaas (2026-09-23). Asaas
// webhooks don't echo the payment link's name, so plan identification
// is done by matching the confirmed payment's value.
export const FUSE_PLANS: FusePlan[] = [
  { value: 197, label: 'Plano FuseHub' },
  { value: 1997, label: 'Plano FuseHub Growth' },
  { value: 3497, label: 'Plano FuseHub Performance' },
]

export function resolvePlanLabel(value: number): string {
  const match = FUSE_PLANS.find((plan) => Math.abs(plan.value - value) < 0.01)
  return match?.label ?? `Plano não identificado (R$ ${value})`
}
