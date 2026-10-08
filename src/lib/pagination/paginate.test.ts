import { describe, expect, it } from 'vitest'
import { paginate } from './paginate'

const list = Array.from({ length: 120 }, (_, i) => i + 1)

describe('paginate', () => {
  it('returns the requested page and the total number of pages', () => {
    const p = paginate(list, 1, 50)
    expect(p.items[0]).toBe(51)
    expect(p.items).toHaveLength(50)
    expect(p.page).toBe(1)
    expect(p.totalPages).toBe(3)
  })

  it('the last page holds only the remainder', () => {
    const p = paginate(list, 2, 50)
    expect(p.items).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i))
  })

  it('clamps a page that no longer exists to the last page', () => {
    expect(paginate(list, 9, 50).page).toBe(2)
    expect(paginate(list, -3, 50).page).toBe(0)
    expect(paginate(list, Number.NaN, 50).page).toBe(0)
  })

  it('an empty list is a single empty page', () => {
    expect(paginate([], 0, 50)).toEqual({ items: [], page: 0, totalPages: 1 })
  })

  it('an exact multiple does not create an extra empty page', () => {
    expect(paginate(list.slice(0, 100), 0, 50).totalPages).toBe(2)
  })
})
