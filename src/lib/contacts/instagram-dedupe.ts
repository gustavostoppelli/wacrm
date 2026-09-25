import type { SupabaseClient } from "@supabase/supabase-js";

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
  args: { igsid: string; username: string | null },
): Promise<{ id: string }> {
  const { data: existing } = await db
    .from("contacts")
    .select("id")
    .eq("account_id", accountId)
    .eq("instagram_id", args.igsid)
    .maybeSingle();

  if (existing) return { id: existing.id as string };

  const { data: created, error } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      phone: null,
      instagram_id: args.igsid,
      instagram_username: args.username,
      name: args.username ?? args.igsid,
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create Instagram contact ${args.igsid}: ${error?.message}`);
  }
  return { id: created.id as string };
}
