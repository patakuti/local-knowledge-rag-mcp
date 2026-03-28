import { readFile } from 'fs/promises'
import { sanitizePathGeneric } from './log-sanitizer.js'

export type LineResolutionInput = {
  quote_start: string
  quote_end: string
  fileContent: string
  hintStartLine?: number
  hintEndLine?: number
}

export type LineResolutionResult = {
  startLine: number
  endLine: number
  resolved: boolean
}

/**
 * Count newline characters in a string between two positions.
 */
function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let i = from; i < to; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

/**
 * Get the character offset of the start of a given line number (1-based).
 */
function getLineOffset(content: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0
  let currentLine = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      currentLine++
      if (currentLine >= lineNumber) {
        return i + 1
      }
    }
  }
  return content.length
}

/**
 * Get the character offset of the end of a given line number (1-based).
 * Returns the position just after the last character of that line (or end of file).
 */
function getLineEndOffset(content: string, lineNumber: number): number {
  let currentLine = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (currentLine === lineNumber) {
        return i + 1
      }
      currentLine++
    }
  }
  // If we reach end of file, return content length
  return content.length
}

/**
 * Resolve exact line numbers by finding quote_start and quote_end
 * in the file content.
 *
 * Uses hint line range (from chunk metadata) to narrow the search.
 * Falls back to full-file search if not found in hint range.
 */
export function resolveLineNumbers(input: LineResolutionInput): LineResolutionResult {
  const { quote_start, quote_end, fileContent, hintStartLine, hintEndLine } = input

  if (!quote_start || !quote_end) {
    return { startLine: 0, endLine: 0, resolved: false }
  }

  // Try hint range first (with ±5 line margin)
  if (hintStartLine !== undefined && hintEndLine !== undefined) {
    const marginStart = Math.max(1, hintStartLine - 5)
    const marginEnd = hintEndLine + 5

    const rangeStart = getLineOffset(fileContent, marginStart)
    const rangeEnd = getLineEndOffset(fileContent, marginEnd)

    const result = findQuoteInRange(fileContent, quote_start, quote_end, rangeStart, rangeEnd)
    if (result) {
      return result
    }
  }

  // Fallback: search entire file
  const result = findQuoteInRange(fileContent, quote_start, quote_end, 0, fileContent.length)
  if (result) {
    return result
  }

  return { startLine: 0, endLine: 0, resolved: false }
}

/**
 * Find quote_start and quote_end within a character range of the file content,
 * then calculate the line numbers.
 */
function findQuoteInRange(
  content: string,
  quoteStart: string,
  quoteEnd: string,
  searchFrom: number,
  searchTo: number
): LineResolutionResult | null {
  const startIdx = content.indexOf(quoteStart, searchFrom)
  if (startIdx === -1 || startIdx >= searchTo) {
    return null
  }

  const endIdx = content.indexOf(quoteEnd, startIdx)
  if (endIdx === -1 || endIdx + quoteEnd.length > searchTo) {
    // Try without the range limit for quote_end (quote might extend slightly beyond hint range)
    const endIdxFull = content.indexOf(quoteEnd, startIdx)
    if (endIdxFull === -1) {
      return null
    }
    const startLine = countNewlines(content, 0, startIdx) + 1
    const endLine = countNewlines(content, 0, endIdxFull + quoteEnd.length) + 1
    return { startLine, endLine, resolved: true }
  }

  const startLine = countNewlines(content, 0, startIdx) + 1
  const endLine = countNewlines(content, 0, endIdx + quoteEnd.length) + 1
  return { startLine, endLine, resolved: true }
}

/**
 * Read file content with caching.
 */
export async function readFileWithCache(
  filePath: string,
  cache: Map<string, string>
): Promise<string | null> {
  const cached = cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    cache.set(filePath, content)
    return content
  } catch (error) {
    console.warn(`[line-resolver] Failed to read file: ${sanitizePathGeneric(filePath)}`)
    return null
  }
}
