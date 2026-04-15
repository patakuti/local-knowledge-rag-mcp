import { SessionManagerImpl } from '../core/session-manager'
import type { SearchResult } from '../types/rag.types'

function makeResult(path: string, similarity = 0.9): SearchResult {
  return {
    path,
    content: `content of ${path}`,
    similarity,
    metadata: { startLine: 1, endLine: 10 },
  }
}

describe('SessionManagerImpl', () => {
  let manager: SessionManagerImpl

  beforeEach(() => {
    manager = new SessionManagerImpl(3)
  })

  describe('addSearchResult / getSearchResult', () => {
    it('stores and retrieves a search result', () => {
      const id = manager.addSearchResult('test query', [makeResult('a.md')])

      const result = manager.getSearchResult(id)
      expect(result).toBeDefined()
      expect(result!.query).toBe('test query')
      expect(result!.results).toHaveLength(1)
      expect(result!.results[0].path).toBe('a.md')
    })

    it('returns undefined for unknown id', () => {
      expect(manager.getSearchResult('nonexistent')).toBeUndefined()
    })
  })

  describe('LRU eviction', () => {
    it('evicts oldest result when maxResults is exceeded', () => {
      const id1 = manager.addSearchResult('q1', [makeResult('a.md')])
      const id2 = manager.addSearchResult('q2', [makeResult('b.md')])
      const id3 = manager.addSearchResult('q3', [makeResult('c.md')])

      expect(manager.searchResults.size).toBe(3)

      // Adding a 4th should evict the oldest (id1)
      manager.addSearchResult('q4', [makeResult('d.md')])

      expect(manager.searchResults.size).toBe(3)
      expect(manager.getSearchResult(id1)).toBeUndefined()
      expect(manager.getSearchResult(id2)).toBeDefined()
      expect(manager.getSearchResult(id3)).toBeDefined()
    })
  })

  describe('listSearchResults', () => {
    it('returns results sorted by timestamp descending', () => {
      const id1 = manager.addSearchResult('q1', [makeResult('a.md')])
      const id2 = manager.addSearchResult('q2', [makeResult('b.md')])

      // Set distinct timestamps to ensure deterministic sort order
      manager.searchResults.get(id1)!.timestamp = new Date('2024-01-01T00:00:00Z')
      manager.searchResults.get(id2)!.timestamp = new Date('2024-01-01T00:01:00Z')

      const list = manager.listSearchResults()
      expect(list).toHaveLength(2)
      // Most recent first
      expect(list[0].query).toBe('q2')
      expect(list[1].query).toBe('q1')
    })

    it('returns empty array when no results', () => {
      expect(manager.listSearchResults()).toEqual([])
    })
  })

  describe('clearResults', () => {
    it('removes all results', () => {
      manager.addSearchResult('q1', [makeResult('a.md')])
      manager.addSearchResult('q2', [makeResult('b.md')])
      manager.clearResults()

      expect(manager.searchResults.size).toBe(0)
      expect(manager.listSearchResults()).toEqual([])
    })
  })

  describe('getResultsByIds', () => {
    it('collects results from multiple session ids', () => {
      const id1 = manager.addSearchResult('q1', [makeResult('a.md')])
      const id2 = manager.addSearchResult('q2', [makeResult('b.md'), makeResult('c.md')])

      const results = manager.getResultsByIds([id1, id2])
      expect(results).toHaveLength(3)
    })

    it('skips unknown ids', () => {
      const id1 = manager.addSearchResult('q1', [makeResult('a.md')])
      const results = manager.getResultsByIds([id1, 'nonexistent'])
      expect(results).toHaveLength(1)
    })
  })

  describe('getResultsBySessionIds', () => {
    it('returns session metadata and aggregated results', () => {
      const id1 = manager.addSearchResult('q1', [makeResult('a.md')])
      const id2 = manager.addSearchResult('q2', [makeResult('b.md'), makeResult('c.md')])

      const { sessions, results } = manager.getResultsBySessionIds([id1, id2])

      expect(sessions).toHaveLength(2)
      expect(sessions[0].query).toBe('q1')
      expect(sessions[0].resultCount).toBe(1)
      expect(sessions[1].query).toBe('q2')
      expect(sessions[1].resultCount).toBe(2)
      expect(results).toHaveLength(3)
    })
  })
})
