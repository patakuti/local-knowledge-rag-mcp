import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadPatternTagRules, tagsForPath, isObsoleteByPatterns, PATTERN_TAGS_FILENAME } from '../utils/pattern-tags'

function withWorkspace(yamlContent: string | null, run: (workspacePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkrag-pattern-tags-'))
  try {
    if (yamlContent !== null) {
      fs.writeFileSync(path.join(dir, PATTERN_TAGS_FILENAME), yamlContent, 'utf-8')
    }
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadPatternTagRules', () => {
  it('returns [] when the config file does not exist', () => {
    withWorkspace(null, (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([])
    })
  })

  it('parses a scalar tag value', () => {
    withWorkspace('"docs/legacy/**": obsolete\n', (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([
        { pattern: 'docs/legacy/**', tags: ['obsolete'] },
      ])
    })
  })

  it('parses an array of tag values', () => {
    withWorkspace('"archive/**": [obsolete, draft]\n', (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([
        { pattern: 'archive/**', tags: ['obsolete', 'draft'] },
      ])
    })
  })

  it('returns [] and does not throw on malformed YAML', () => {
    withWorkspace('"unterminated: [oops\n', (workspacePath) => {
      expect(() => loadPatternTagRules(workspacePath)).not.toThrow()
      expect(loadPatternTagRules(workspacePath)).toEqual([])
    })
  })

  it('returns [] when the top level is not a mapping', () => {
    withWorkspace('- just\n- a\n- list\n', (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([])
    })
  })

  it('skips an entry with an empty pattern', () => {
    withWorkspace('"": obsolete\n"docs/**": obsolete\n', (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([{ pattern: 'docs/**', tags: ['obsolete'] }])
    })
  })

  it('skips an entry with no valid tags', () => {
    withWorkspace('"docs/**": ""\n', (workspacePath) => {
      expect(loadPatternTagRules(workspacePath)).toEqual([])
    })
  })
})

describe('tagsForPath / isObsoleteByPatterns', () => {
  const rules = [
    { pattern: 'docs/legacy/**', tags: ['obsolete'] },
    { pattern: 'notes/*.md', tags: ['draft'] },
  ]

  it('matches a directory wildcard', () => {
    expect(tagsForPath('docs/legacy/old.md', rules)).toEqual(['obsolete'])
    expect(isObsoleteByPatterns('docs/legacy/old.md', rules)).toBe(true)
  })

  it('matches a single-level wildcard', () => {
    expect(tagsForPath('notes/todo.md', rules)).toEqual(['draft'])
    expect(isObsoleteByPatterns('notes/todo.md', rules)).toBe(false)
  })

  it('returns no tags for a non-matching path', () => {
    expect(tagsForPath('src/index.ts', rules)).toEqual([])
    expect(isObsoleteByPatterns('src/index.ts', rules)).toBe(false)
  })
})
