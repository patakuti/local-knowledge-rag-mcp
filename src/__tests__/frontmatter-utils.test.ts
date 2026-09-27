import { parseFrontmatter, hasObsoleteTag } from '../utils/frontmatter-utils'

describe('parseFrontmatter', () => {
  it('returns unchanged content when there is no frontmatter', () => {
    const content = '# Just a heading\n\nSome body text.'
    const result = parseFrontmatter(content)

    expect(result.data).toBeNull()
    expect(result.body).toBe(content)
  })

  it('extracts a YAML frontmatter block and strips it from the body', () => {
    const content = ['---', 'title: Doc', 'tags: obsolete', '---', 'Body text.'].join('\n')
    const result = parseFrontmatter(content)

    expect(result.data).toEqual({ title: 'Doc', tags: 'obsolete' })
    expect(result.body).toBe('Body text.')
  })

  it('treats malformed YAML as no frontmatter, without throwing', () => {
    const content = ['---', 'tags: [unterminated', '---', 'Body text.'].join('\n')
    expect(() => parseFrontmatter(content)).not.toThrow()

    const result = parseFrontmatter(content)
    expect(result.data).toBeNull()
    expect(result.body).toBe(content)
  })
})

describe('hasObsoleteTag', () => {
  it('returns false when there is no frontmatter data', () => {
    expect(hasObsoleteTag(null)).toBe(false)
  })

  it('detects a scalar `tags: obsolete` value', () => {
    expect(hasObsoleteTag({ tags: 'obsolete' })).toBe(true)
  })

  it('detects `obsolete` inside a `tags:` array', () => {
    expect(hasObsoleteTag({ tags: ['draft', 'obsolete'] })).toBe(true)
  })

  it('detects `obsolete` via the singular `tag:` key', () => {
    expect(hasObsoleteTag({ tag: 'obsolete' })).toBe(true)
  })

  it('normalizes case and a leading #', () => {
    expect(hasObsoleteTag({ tags: '#Obsolete' })).toBe(true)
  })

  it('returns false when other tags are present but not obsolete', () => {
    expect(hasObsoleteTag({ tags: ['draft', 'reviewed'] })).toBe(false)
  })
})
