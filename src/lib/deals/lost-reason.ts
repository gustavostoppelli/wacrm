// ============================================================
// Allowed values for `deals.lost_reason` — single source of truth
// shared by the "mark as lost" prompt and migration 053's CHECK
// constraint. Mirrors the DEAL_SOURCES pattern in ./source.ts.
// ============================================================

export const LOST_REASONS = [
  'Preço',
  'Sem resposta',
  'Escolheu concorrente',
  'Fora do momento',
  'Fora do perfil ideal',
  'Outro',
] as const;

export type LostReason = (typeof LOST_REASONS)[number];

export function isLostReason(value: unknown): value is LostReason {
  return (
    typeof value === 'string' &&
    (LOST_REASONS as readonly string[]).includes(value)
  );
}
