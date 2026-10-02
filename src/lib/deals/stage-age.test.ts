import { describe, expect, it } from "vitest";
import { daysInStage, isStaleInStage } from "./stage-age";

describe("daysInStage", () => {
  const now = new Date("2026-08-29T12:00:00Z");

  it("returns 0 for a deal that entered the stage minutes ago", () => {
    expect(daysInStage("2026-08-29T11:20:00Z", now)).toBe(0);
  });

  it("returns 0 for a deal entered earlier the same calendar day", () => {
    expect(daysInStage("2026-08-29T10:00:00Z", now)).toBe(0);
  });

  it("counts a calendar-day crossing as 1, even under 24h elapsed", () => {
    // Entered 11pm the day before "now" — only 13h elapsed, but it's
    // a different calendar date, which is what the UI actually shows.
    expect(daysInStage("2026-08-28T23:00:00Z", now)).toBe(1);
  });

  it("counts whole calendar days for a multi-day gap", () => {
    expect(daysInStage("2026-08-27T13:00:00Z", now)).toBe(2);
  });

  it("returns exact whole days for an exact multiple", () => {
    expect(daysInStage("2026-08-24T12:00:00Z", now)).toBe(5);
  });

  it("never returns a negative number for a future timestamp", () => {
    expect(daysInStage("2026-08-30T12:00:00Z", now)).toBe(0);
  });
});

describe("isStaleInStage", () => {
  it("is false when the stage has no threshold configured", () => {
    expect(isStaleInStage(10, null)).toBe(false);
    expect(isStaleInStage(10, undefined)).toBe(false);
  });

  it("is false when under the threshold", () => {
    expect(isStaleInStage(1, 2)).toBe(false);
  });

  it("is true at or past the threshold", () => {
    expect(isStaleInStage(2, 2)).toBe(true);
    expect(isStaleInStage(5, 2)).toBe(true);
  });

  it("ignores a zero or negative threshold (treated as disabled)", () => {
    expect(isStaleInStage(5, 0)).toBe(false);
  });
});
