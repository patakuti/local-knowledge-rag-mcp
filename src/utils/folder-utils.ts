import { minimatch } from 'minimatch'
import type { SearchResult } from '../types/rag.types.js'

/**
 * Convert folder parameter to glob pattern
 *
 * Supports 3 patterns:
 * 1. Subdirectory name: "hooks" becomes "*\/\*\/hooks\/\*\/\*"
 * 2. Root-relative path: "/src/hooks" becomes "src/hooks\/\*\/\*"
 * 3. Glob pattern: "src\/\*\/tests" stays as-is
 */
export function convertFolderToGlob(folder: string): string {
  // Glob pattern (contains *) → use as-is
  if (folder.includes('*')) {
    return folder
  }

  // Root-relative path (starts with /) → remove / and add /**
  if (folder.startsWith('/')) {
    return folder.substring(1) + '/**'
  }

  // Subdirectory name → surround with **/ and /**
  return `**/${folder}/**`
}

/**
 * Filter search results by folder patterns
 *
 * Uses minimatch for glob pattern matching
 * Multiple patterns are combined with OR condition
 */
export function filterByFolders(
  results: SearchResult[],
  folders: string[]
): SearchResult[] {
  // If no folders specified, return all results
  if (!folders || folders.length === 0) {
    return results
  }

  // Convert each folder to glob pattern
  const patterns = folders.map(convertFolderToGlob)

  // Filter results: match if any pattern matches
  return results.filter(result => {
    return patterns.some(pattern =>
      minimatch(result.path, pattern, { matchBase: false })
    )
  })
}
