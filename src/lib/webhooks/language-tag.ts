import type { SupabaseClient } from '@supabase/supabase-js'

import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { detectLeadLanguage, type LeadLanguage } from './language'

export const LANGUAGE_TAG_ES = 'idioma_es'
export const LANGUAGE_TAG_PT = 'idioma_pt'

async function findOrCreateTag(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  name: string,
): Promise<string> {
  const find = async () => {
    const { data } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', name)
      .limit(1)
      .maybeSingle()
    return (data?.id as string | undefined) ?? null
  }
  const existing = await find()
  if (existing) return existing
  const { data, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name, color: '#f59e0b' })
    .select('id')
    .single()
  if (error) {
    // Lost a create race: someone else made it first.
    const again = await find()
    if (again) return again
    throw error
  }
  return data.id as string
}

/**
 * Work out the lead's language and, for Spanish, tag the contact
 * `idioma_es` so automations can branch on it with a plain tag Condition.
 *
 * A manual choice always wins: a contact that already carries `idioma_pt`
 * or `idioma_es` is left exactly as it is, and that tag decides the
 * language. Portuguese is the default and is not tagged (it would mark
 * thousands of contacts for nothing); put `idioma_pt` on a contact to
 * pin it to Portuguese against the automatic guess.
 */
export async function resolveContactLanguage(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    contactId: string | null
    phone: string | null
    countryIso: string | null
  },
): Promise<LeadLanguage> {
  const detected = detectLeadLanguage({ phone: args.phone, countryIso: args.countryIso })
  if (!args.contactId) return detected

  const { data: existing } = await db
    .from('contact_tags')
    .select('tags!inner(name, account_id)')
    .eq('contact_id', args.contactId)
    .eq('tags.account_id', args.accountId)
    .in('tags.name', [LANGUAGE_TAG_ES, LANGUAGE_TAG_PT])
  const names = new Set(
    ((existing ?? []) as unknown as { tags: { name: string } | { name: string }[] }[]).flatMap(
      (r) => (Array.isArray(r.tags) ? r.tags : [r.tags]).map((t) => t.name),
    ),
  )
  if (names.has(LANGUAGE_TAG_PT)) return 'pt'
  if (names.has(LANGUAGE_TAG_ES)) return 'es'

  if (detected === 'es') {
    const tagId = await findOrCreateTag(db, args.accountId, args.userId, LANGUAGE_TAG_ES)
    await addContactTagIfAbsent(db, {
      accountId: args.accountId,
      contactId: args.contactId,
      tagId,
    })
  }
  return detected
}
