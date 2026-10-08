/**
 * Fetch every row of a query that the database caps per request.
 *
 * Supabase/PostgREST returns at most 1000 rows per request, silently — a
 * plain `select()` on a table with more rows just comes back truncated.
 * This walks the result with `.range()`-style windows until a page comes
 * back short. `fetchPage(from, to)` must return rows in a STABLE order
 * (order by a unique column as the last tie-breaker), otherwise rows can
 * repeat or go missing between pages.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
  maxPages = 200,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const rows = await fetchPage(from, from + pageSize - 1)
    all.push(...rows)
    if (rows.length < pageSize) break
  }
  return all
}
