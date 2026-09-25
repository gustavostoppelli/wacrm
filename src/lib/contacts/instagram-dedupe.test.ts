import { describe, it, expect, vi, beforeEach } from "vitest";
import { findOrCreateInstagramContact } from "./instagram-dedupe";

function makeDb(overrides: { existing?: { id: string } | null; insertResult?: { id: string } } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: overrides.existing ?? null, error: null });
  const eqChain = { maybeSingle };
  const select = vi.fn(() => ({
    eq: vi.fn(() => ({ eq: vi.fn(() => eqChain) })),
  }));
  const insertSingle = vi.fn().mockResolvedValue({
    data: overrides.insertResult ?? { id: "new-contact-1" },
    error: null,
  });
  const insertSelect = vi.fn(() => ({ single: insertSingle }));
  const insert = vi.fn(() => ({ select: insertSelect }));
  return {
    from: vi.fn(() => ({ select, insert })),
    _spies: { select, insert, maybeSingle, insertSingle },
  };
}

describe("findOrCreateInstagramContact", () => {
  it("returns the existing contact when one matches instagram_id", async () => {
    const db = makeDb({ existing: { id: "existing-1" } });
    const result = await findOrCreateInstagramContact(db as never, "acc-1", {
      igsid: "igsid-123",
      username: "joana",
    });
    expect(result).toEqual({ id: "existing-1" });
    expect(db._spies.insert).not.toHaveBeenCalled();
  });

  it("creates a phone-less contact when none matches", async () => {
    const db = makeDb({ existing: null, insertResult: { id: "new-contact-1" } });
    const result = await findOrCreateInstagramContact(db as never, "acc-1", {
      igsid: "igsid-456",
      username: "pedro",
    });
    expect(result).toEqual({ id: "new-contact-1" });
    expect(db._spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        instagram_id: "igsid-456",
        instagram_username: "pedro",
        phone: null,
        name: "pedro",
      }),
    );
  });

  it("falls back to the igsid as the name when no username is available", async () => {
    const db = makeDb({ existing: null, insertResult: { id: "new-contact-2" } });
    await findOrCreateInstagramContact(db as never, "acc-1", { igsid: "igsid-789", username: null });
    expect(db._spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "igsid-789", instagram_username: null }),
    );
  });
});
