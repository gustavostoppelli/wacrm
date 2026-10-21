import { describe, expect, it } from 'vitest'
import { displayNameFor } from './display-name'

describe('displayNameFor', () => {
  it('keeps only the first line', () => {
    expect(displayNameFor('Elóvia clínic\nELÓVIA CLINIC RECEPÇÃO')).toBe('Elóvia clínic')
  })
  it('drops text after a separator', () => {
    expect(displayNameFor('Clínica Biavatti Champagnat | Secretária')).toBe('Clínica Biavatti Champagnat')
    expect(displayNameFor('Dr. Fabio Barros - Harmonização facial (alto padrão)')).toBe('Dr. Fabio Barros')
  })
  it('leaves a plain name alone and tolerates empty values', () => {
    expect(displayNameFor('Maria Silva')).toBe('Maria Silva')
    expect(displayNameFor(null)).toBe('')
  })
})
