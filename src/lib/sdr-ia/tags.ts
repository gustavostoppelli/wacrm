// ============================================================
// Tag resolution for SDR IA — same find-or-create semantics as
// src/lib/contacts/resolve-import-tags.ts, narrowed to a single name
// since the wizard resolves one tag at a time (lead tag, "contacted"
// tag, up to 3 variant tags).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_TAG_COLOR = '#3b82f6'

export async function resolveOrCreateTagId(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim()
  // Escape ILIKE wildcard characters (% and _) so a name containing
  // them is matched literally, not as a pattern — an unescaped `_`
  // would match ANY single character, so e.g. "sdr-ia-contatado"
  // would wrongly match "sdr_ia_contatado" (and vice versa).
  const escaped = trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)

  const { data: existing, error: lookupError } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', escaped)
    .maybeSingle()

  if (lookupError) {
    // maybeSingle() errors when more than one row matches (or on other
    // DB errors) — never fall through to creating a NEW tag in that
    // case: resolving "sdr_ia_contatado" to a fresh, empty tag would
    // make every previously-contacted lead look untouched and get
    // re-messaged.
    throw new Error(`Failed to look up tag "${trimmed}": ${lookupError.message}`)
  }
  if (existing) return existing.id as string

  const { data: created, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name: trimmed, color: DEFAULT_TAG_COLOR })
    .select('id')
    .single()

  if (error || !created) {
    throw new Error(`Failed to create tag "${trimmed}": ${error?.message}`)
  }
  return created.id as string
}

/** 1-indexed: variantTagName(1) === 'sdr_ia_variante_1'. */
export function variantTagName(n: number): string {
  return `sdr_ia_variante_${n}`
}
