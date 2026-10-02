import { differenceInCalendarDays } from "date-fns";

// ============================================================
// Days-in-stage helpers — shared by the Kanban card badge and the
// stuck-deals report so both agree on the exact same math.
//
// Counts CALENDAR days crossed since `stage_entered_at`, not whole
// 24h periods — a deal entered yesterday at 11pm reads "1 dia" first
// thing this morning, matching what the date on screen actually says,
// instead of staying "0 dias" until a full 24 hours has elapsed (the
// original behavior here — a user flagged it as "stuck at 0 days"
// for cards that were clearly created the day before).
// ============================================================

/** Calendar days elapsed between `stageEnteredAt` and now (or `now`, for tests). */
export function daysInStage(stageEnteredAt: string, now: Date = new Date()): number {
  return Math.max(0, differenceInCalendarDays(now, new Date(stageEnteredAt)));
}

/** True iff a stage has an alert threshold and the deal has crossed it. */
export function isStaleInStage(days: number, staleAfterDays?: number | null): boolean {
  return typeof staleAfterDays === "number" && staleAfterDays > 0 && days >= staleAfterDays;
}
