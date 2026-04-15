import { resolveLineNumbers } from '../utils/line-resolver'

const sampleContent = [
  'line 1: introduction',
  'line 2: some text here',
  'line 3: important concept',
  'line 4: more details',
  'line 5: another section',
  'line 6: conclusion',
].join('\n')

describe('resolveLineNumbers', () => {
  it('finds quote in file and returns correct line numbers', () => {
    const result = resolveLineNumbers({
      quote_start: 'important concept',
      quote_end: 'more details',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(true)
    expect(result.startLine).toBe(3)
    expect(result.endLine).toBe(4)
  })

  it('returns resolved=false when quote_start is empty', () => {
    const result = resolveLineNumbers({
      quote_start: '',
      quote_end: 'something',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(false)
    expect(result.startLine).toBe(0)
    expect(result.endLine).toBe(0)
  })

  it('returns resolved=false when quote_end is empty', () => {
    const result = resolveLineNumbers({
      quote_start: 'something',
      quote_end: '',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(false)
  })

  it('returns resolved=false when quote is not found', () => {
    const result = resolveLineNumbers({
      quote_start: 'nonexistent text',
      quote_end: 'also missing',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(false)
  })

  it('uses hint range to narrow search', () => {
    const result = resolveLineNumbers({
      quote_start: 'important concept',
      quote_end: 'more details',
      fileContent: sampleContent,
      hintStartLine: 3,
      hintEndLine: 4,
    })

    expect(result.resolved).toBe(true)
    expect(result.startLine).toBe(3)
    expect(result.endLine).toBe(4)
  })

  it('falls back to full search when hint range misses', () => {
    // Hint range is lines 1-2, but quote is on lines 3-4
    const result = resolveLineNumbers({
      quote_start: 'important concept',
      quote_end: 'more details',
      fileContent: sampleContent,
      hintStartLine: 1,
      hintEndLine: 1,
    })

    // ±5 margin means hint range covers lines 1-6, so it still finds it
    expect(result.resolved).toBe(true)
    expect(result.startLine).toBe(3)
  })

  it('handles single-line quote (start and end on same line)', () => {
    const result = resolveLineNumbers({
      quote_start: 'introduction',
      quote_end: 'introduction',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(true)
    expect(result.startLine).toBe(1)
    expect(result.endLine).toBe(1)
  })

  it('handles quote at end of file', () => {
    const result = resolveLineNumbers({
      quote_start: 'conclusion',
      quote_end: 'conclusion',
      fileContent: sampleContent,
    })

    expect(result.resolved).toBe(true)
    expect(result.startLine).toBe(6)
    expect(result.endLine).toBe(6)
  })
})
