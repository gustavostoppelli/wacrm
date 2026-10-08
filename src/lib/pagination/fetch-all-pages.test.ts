import { describe, expect, it, vi } from 'vitest'
import { fetchAllPages } from './fetch-all-pages'

function source(total: number) {
  const rows = Array.from({ length: total }, (_, i) => i)
  return vi.fn(async (from: number, to: number) => rows.slice(from, to + 1))
}

describe('fetchAllPages', () => {
  it('returns everything when the table is larger than one page', async () => {
    const fetchPage = source(2500)
    const all = await fetchAllPages(fetchPage, 1000)
    expect(all).toHaveLength(2500)
    expect(all[0]).toBe(0)
    expect(all[2499]).toBe(2499)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(fetchPage).toHaveBeenNthCalledWith(2, 1000, 1999)
  })

  it('stops after one request when the result fits in a page', async () => {
    const fetchPage = source(40)
    expect(await fetchAllPages(fetchPage, 1000)).toHaveLength(40)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('needs one extra (empty) request when the total is an exact multiple of the page size', async () => {
    const fetchPage = source(2000)
    expect(await fetchAllPages(fetchPage, 1000)).toHaveLength(2000)
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('returns an empty list for an empty table', async () => {
    expect(await fetchAllPages(source(0), 1000)).toEqual([])
  })

  it('never loops forever: it gives up after maxPages', async () => {
    const endless = vi.fn(async () => Array.from({ length: 10 }, (_, i) => i))
    const all = await fetchAllPages(endless, 10, 5)
    expect(endless).toHaveBeenCalledTimes(5)
    expect(all).toHaveLength(50)
  })
})
