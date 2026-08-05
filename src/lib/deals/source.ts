// ============================================================
// Allowed values for `deals.source` — single source of truth shared
// by the deal form's dropdown, the public API's validation, and
// migration 038's CHECK constraint. Mirrors the `canal_origem`
// dropdown on the sales team's prospecting master spreadsheet, so a
// deal's source uses the same vocabulary across both systems.
// ============================================================

export const DEAL_SOURCES = [
  'Formulário do Site — Diagnóstico',
  'Tráfego Pago (Meta/Google Ads)',
  'Prospecção Outbound',
  'Apify',
  'Indicação',
  'Instagram / Orgânico',
  'WhatsApp Direto',
  'Evento / Parceria',
  'Outro',
] as const;

export type DealSource = (typeof DEAL_SOURCES)[number];

export function isDealSource(value: unknown): value is DealSource {
  return (
    typeof value === 'string' &&
    (DEAL_SOURCES as readonly string[]).includes(value)
  );
}
