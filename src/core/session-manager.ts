import type { SearchResult, SessionSearchResult, SessionManager } from '../types/rag.types.js'
import { randomUUID } from 'crypto'

export class SessionManagerImpl implements SessionManager {
  public searchResults = new Map<string, SessionSearchResult>()
  public maxResults: number

  constructor(maxResults = 10) {
    this.maxResults = maxResults
  }

  addSearchResult(query: string, results: SearchResult[]): string {
    // LRU deletion: if max capacity reached, delete oldest result
    if (this.searchResults.size >= this.maxResults) {
      const oldestId = this.findOldestResult()
      if (oldestId) {
        this.searchResults.delete(oldestId)
      }
    }

    const id = `search_${randomUUID().slice(0, 8)}`
    const sessionResult: SessionSearchResult = {
      id,
      query,
      timestamp: new Date(),
      results
    }

    this.searchResults.set(id, sessionResult)
    return id
  }

  getSearchResult(id: string): SessionSearchResult | undefined {
    return this.searchResults.get(id)
  }

  listSearchResults(): SessionSearchResult[] {
    return Array.from(this.searchResults.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  clearResults(): void {
    this.searchResults.clear()
  }

  getResultsByIds(ids: string[]): SearchResult[] {
    const allResults: SearchResult[] = []

    for (const id of ids) {
      const sessionResult = this.searchResults.get(id)
      if (sessionResult) {
        allResults.push(...sessionResult.results)
      }
    }

    return allResults
  }


  getResultsBySessionIds(sessionIds: string[]): {
    sessions: Array<{ sessionId: string; query: string; resultCount: number }>
    results: SearchResult[]
  } {
    const sessions: Array<{ sessionId: string; query: string; resultCount: number }> = []
    const allResults: SearchResult[] = []

    for (const sessionId of sessionIds) {
      const session = this.getSearchResult(sessionId)
      if (session) {
        sessions.push({
          sessionId: sessionId,
          query: session.query,
          resultCount: session.results.length
        })
        allResults.push(...session.results)
      }
    }

    return { sessions, results: allResults }
  }

  private findOldestResult(): string | undefined {
    let oldestId: string | undefined
    let oldestTime = Date.now()

    for (const [id, result] of this.searchResults) {
      if (result.timestamp.getTime() < oldestTime) {
        oldestTime = result.timestamp.getTime()
        oldestId = id
      }
    }

    return oldestId
  }
}