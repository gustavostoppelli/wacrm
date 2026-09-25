import type { SupabaseClient } from "@supabase/supabase-js";

const UNIQUE_VIOLATION = "23505";

/**
 * Find-or-create a contact from an Instagram event (comment or DM),
 * keyed by the Instagram-scoped id (IGSID) rather than phone — mirrors
 * findExistingContact (src/lib/contacts/dedupe.ts), which keys off
 * phone instead. Never has a phone number: the two dedupe paths are
 * deliberately separate rather than unified, since they use different
 * uniqueness keys (migration 075's idx_contacts_account_instagram_id
 * vs migration 022's idx_contacts_account_phone_normalized).
 */
export async function findOrCreateInstagramContact(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  args: { igsid: string; username: string | null },
): Promise<{ id: string }> {
  const findExisting = () =>
    db
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .eq("instagram_id", args.igsid)
      .maybeSingle();

  const { data: existing } = await findExisting();
  if (existing) return { id: existing.id as string };

  const { data: created, error } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      user_id: userId,
      phone: null,
      instagram_id: args.igsid,
      instagram_username: args.username,
      name: args.username ?? args.igsid,
    })
    .select("id")
    .single();

  if (error) {
    // Two concurrent first-time events from the same new IGSID (e.g. a
    // comment and a DM arriving close together) can both pass the
    // SELECT above and both attempt the INSERT — the loser hits the
    // unique index (idx_contacts_account_instagram_id) instead of
    // losing the event. Same race-handling convention as
    // findOrCreateInternalRecipient (src/lib/automations/engine.ts).
    if (error.code === UNIQUE_VIOLATION) {
      const { data: raced } = await findExisting();
      if (raced) return { id: raced.id as string };
    }
    throw new Error(`Failed to create Instagram contact ${args.igsid}: ${error.message}`);
  }
  if (!created) {
    throw new Error(`Failed to create Instagram contact ${args.igsid}: no row returned`);
  }
  return { id: created.id as string };
}
