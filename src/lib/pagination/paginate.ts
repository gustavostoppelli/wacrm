/**
 * Slice a list into pages. `page` is 0-based and is clamped into range, so a
 * page that no longer exists (e.g. after cards were moved out of a column)
 * falls back to the last real page instead of showing an empty list.
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safe = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1)
  return { items: items.slice(safe * pageSize, (safe + 1) * pageSize), page: safe, totalPages }
}
