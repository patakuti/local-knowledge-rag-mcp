import { tagsFromYamlValue, normalizeTag, isObsoleteTag } from '../utils/tag-utils'

describe('tagsFromYamlValue', () => {
  it('accepts an array of strings/numbers', () => {
    expect(tagsFromYamlValue(['draft', 42])).toEqual(['draft', '42'])
  })

  it('splits a comma/space-separated string', () => {
    expect(tagsFromYamlValue('draft, obsolete  reviewed')).toEqual(['draft', 'obsolete', 'reviewed'])
  })

  it('returns an empty array for unsupported shapes', () => {
    expect(tagsFromYamlValue(undefined)).toEqual([])
    expect(tagsFromYamlValue({ nested: true })).toEqual([])
  })
})

describe('normalizeTag', () => {
  it('trims, lowercases, and strips a leading #', () => {
    expect(normalizeTag('  #Obsolete  ')).toBe('obsolete')
  })
})

describe('isObsoleteTag', () => {
  it('detects the reserved obsolete value', () => {
    expect(isObsoleteTag(['draft', 'obsolete'])).toBe(true)
  })

  it('returns false when obsolete is absent', () => {
    expect(isObsoleteTag(['draft', 'reviewed'])).toBe(false)
  })

  it('returns false for an empty list', () => {
    expect(isObsoleteTag([])).toBe(false)
  })
})
