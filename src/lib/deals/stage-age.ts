// ============================================================
// Days-in-stage helpers — shared by the Kanban card badge and the
// stuck-deals report so both agree on the exact same math (whole
// days elapsed since `stage_entered_at`, floor rather than round, so
// a deal that entered 40 minutes ago reads "0 dias" instead of
// rounding up to "1 dia").
// ============================================================

/** Whole days elapsed between `stageEnteredAt` and now (or `now`, for tests). */
export function daysInStage(stageEnteredAt: string, now: Date = new Date()): number {
  const entered = new Date(stageEnteredAt).getTime();
  const diffMs = now.getTime() - entered;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/** True iff a stage has an alert threshold and the deal has crossed it. */
export function isStaleInStage(days: number, staleAfterDays?: number | null): boolean {
  return typeof staleAfterDays === "number" && staleAfterDays > 0 && days >= staleAfterDays;
}
