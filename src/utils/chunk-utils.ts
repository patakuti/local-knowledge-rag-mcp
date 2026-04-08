import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import type { ContentChunk, ChunkingConfig, VectorMetaData } from '../types/rag.types.js'
import { sanitizePathGeneric } from './log-sanitizer.js'

export class TextChunker {
  private splitter: RecursiveCharacterTextSplitter

  constructor(config: ChunkingConfig) {
    // Use plain text splitter to preserve newlines
    // LangChain's fromLanguage() for markdown removes newlines
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      separators: ['\n\n', '\n', '. ', ' ', ''], // Preserve paragraph and line structure
      keepSeparator: true, // Keep the separators (newlines) in the output
    })
  }

  /**
   * Split text into chunks with metadata
   */
  async createChunks(
    content: string,
    filePath: string,
    mtime: number
  ): Promise<ContentChunk[]> {
    try {
      const documents = await this.splitter.createDocuments([content])

      // Build a line offset lookup table once: lineOffsets[i] = character offset
      // where line (i+1) starts. This allows O(log n) line number lookups
      // instead of the previous O(n) per-chunk scan.
      const lineOffsets = this.buildLineOffsets(content)

      // Track search position to handle duplicate chunk text correctly
      // (chunks are returned in document order)
      let searchFrom = 0

      return documents.map((doc): ContentChunk => {
        const chunkContent = doc.pageContent
        const { startLine, endLine, nextSearchFrom } =
          this.calculateLineNumbers(content, chunkContent, searchFrom, lineOffsets)
        searchFrom = nextSearchFrom

        const metadata: VectorMetaData = {
          startLine,
          endLine,
        }

        return {
          path: filePath,
          mtime,
          content: chunkContent,
          metadata
        }
      })
    } catch (error) {
      // Fallback: create a single chunk if splitting fails
      console.warn(`Failed to split content for ${filePath}, using single chunk:`, error)

      return [{
        path: filePath,
        mtime,
        content,
        metadata: {
          startLine: 1,
          endLine: content.split('\n').length
        }
      }]
    }
  }

  /**
   * Build a sorted array of character offsets where each line starts.
   * lineOffsets[0] = 0 (line 1 starts at offset 0).
   * Used for O(log n) binary search in getLineAtOffset.
   */
  private buildLineOffsets(content: string): number[] {
    const offsets = [0]
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        offsets.push(i + 1)
      }
    }
    return offsets
  }

  /**
   * Get the 1-based line number for a character offset using binary search.
   */
  private getLineAtOffset(offset: number, lineOffsets: number[]): number {
    let lo = 0
    let hi = lineOffsets.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (lineOffsets[mid] <= offset) {
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return lo // 1-based line number
  }

  /**
   * Calculate line numbers using character offset matching.
   * Finds the chunk in the original content by character position,
   * then uses the precomputed line offset table for O(log n) lookup.
   */
  private calculateLineNumbers(
    originalContent: string,
    chunkContent: string,
    searchFrom: number,
    lineOffsets: number[]
  ): { startLine: number; endLine: number; nextSearchFrom: number } {
    // Trim leading/trailing whitespace from chunk for matching,
    // since keepSeparator can prepend separators to chunks
    const trimmed = chunkContent.trim()
    let offset = originalContent.indexOf(trimmed, searchFrom)

    if (offset === -1) {
      // Fallback: search from the beginning
      offset = originalContent.indexOf(trimmed)
      if (offset === -1) {
        return { startLine: 1, endLine: lineOffsets.length, nextSearchFrom: searchFrom }
      }
    }

    const startLine = this.getLineAtOffset(offset, lineOffsets)
    const endOffset = offset + trimmed.length
    const endLine = this.getLineAtOffset(endOffset > 0 ? endOffset - 1 : 0, lineOffsets)
    return { startLine, endLine, nextSearchFrom: offset + trimmed.length }
  }

  /**
   * Create chunks for multiple files
   */
  async createChunksForFiles(
    files: Array<{ path: string; content: string; mtime: number }>,
    onProgress?: (completedFiles: number, totalFiles: number, totalChunks: number) => void
  ): Promise<ContentChunk[]> {
    const allChunks: ContentChunk[] = []
    const logInterval = Math.max(1, Math.floor(files.length / 10))

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const fileSizeKB = (file.content.length / 1024).toFixed(0)

      // Log before processing large files (>50KB) so we can see which file is being processed
      if (file.content.length >= 50 * 1024) {
        console.error(`[createChunksForFiles] Processing large file: ${sanitizePathGeneric(file.path)} (${fileSizeKB}KB)...`)
      }

      try {
        const chunks = await this.createChunks(file.content, file.path, file.mtime)
        allChunks.push(...chunks)
        // Log after processing files that produced many chunks
        if (chunks.length >= 100) {
          console.error(`[createChunksForFiles] Large file done: ${sanitizePathGeneric(file.path)} → ${chunks.length} chunks (${fileSizeKB}KB)`)
        }
      } catch (error) {
        console.error(`Failed to create chunks for ${sanitizePathGeneric(file.path)}:`, error)
        // Continue with other files even if one fails
      }

      // Yield to the event loop every file so the HTTP server stays responsive
      await new Promise<void>(resolve => setImmediate(resolve))

      if ((i + 1) % logInterval === 0) {
        const pct = Math.floor(((i + 1) / files.length) * 100)
        console.error(`[createChunksForFiles] ${i + 1}/${files.length} files (${pct}%), ${allChunks.length} chunks so far`)
        onProgress?.(i + 1, files.length, allChunks.length)
      }
    }

    return allChunks
  }

  /**
   * Validate chunk content
   */
  validateChunk(chunk: ContentChunk): boolean {
    // Check for empty content
    if (!chunk.content || chunk.content.trim().length === 0) {
      return false
    }

    // Check for null bytes (can cause database issues)
    if (chunk.content.includes('\x00')) {
      return false
    }

    // Check for reasonable content length
    if (chunk.content.length > this.splitter.chunkSize * 2) {
      console.warn(`Chunk too large: ${sanitizePathGeneric(chunk.path)}, length: ${chunk.content.length}`)
      return false
    }

    return true
  }

  /**
   * Clean and validate chunks
   */
  processChunks(chunks: ContentChunk[]): ContentChunk[] {
    return chunks
      .map(chunk => ({
        ...chunk,
        content: this.sanitizeContent(chunk.content)
      }))
      .filter(chunk => this.validateChunk(chunk))
  }

  /**
   * Sanitize chunk content
   */
  private sanitizeContent(content: string): string {
    // Remove null bytes
    // eslint-disable-next-line no-control-regex
    let sanitized = content.replace(/\x00/g, '')

    // Normalize line endings
    sanitized = sanitized.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // Remove excessive whitespace but preserve structure
    sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n')

    return sanitized.trim()
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokenCount(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4)
  }

  /**
   * Get chunk statistics
   */
  getChunkStats(chunks: ContentChunk[]): {
    totalChunks: number
    totalCharacters: number
    avgChunkSize: number
    estimatedTokens: number
  } {
    const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0)
    const totalChunks = chunks.length
    const avgChunkSize = totalChunks > 0 ? totalCharacters / totalChunks : 0
    const estimatedTokens = this.estimateTokenCount(chunks.map(c => c.content).join(''))

    return {
      totalChunks,
      totalCharacters,
      avgChunkSize,
      estimatedTokens
    }
  }
}

/**
 * Utility functions for text processing
 */
export class TextUtils {
  /**
   * Extract text from different file types
   */
  static extractTextContent(content: string, fileExtension: string, excludeCodeLanguages?: string[]): string {
    switch (fileExtension.toLowerCase()) {
      case '.md':
      case '.markdown':
        return TextUtils.extractFromMarkdown(content, excludeCodeLanguages)

      case '.html':
      case '.htm':
        return TextUtils.extractFromHtml(content)

      case '.json':
        return TextUtils.extractFromJson(content)

      default:
        return content
    }
  }

  /**
   * Extract plain text from Markdown
   * Selectively removes code blocks based on language identifier
   */
  private static extractFromMarkdown(content: string, excludeCodeLanguages?: string[]): string {
    // Remove code blocks selectively based on language
    if (excludeCodeLanguages && excludeCodeLanguages.length > 0) {
      // Replace fenced code blocks with language identifiers in the exclude list
      // Pattern: ```language\n...code...\n```
      content = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        if (!lang) {
          // No language specified - keep the code block content
          return code
        }
        const langLower = lang.toLowerCase()
        if (excludeCodeLanguages.includes(langLower)) {
          // Excluded language - remove the code block
          return ''
        }
        // Keep the code block content (without the fences)
        return code
      })
    } else {
      // No exclusion list - keep all fenced code blocks (remove only fences)
      content = content.replace(/```\w*\n([\s\S]*?)```/g, '$1')
    }

    // Remove inline code
    content = content.replace(/`[^`\n]+`/g, '')

    // Remove links but keep text
    content = content.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Remove headers formatting but keep text
    content = content.replace(/^#{1,6}\s+/gm, '')

    // Remove emphasis formatting
    content = content.replace(/\*\*([^*]+)\*\*/g, '$1')
    content = content.replace(/\*([^*]+)\*/g, '$1')
    content = content.replace(/__([^_]+)__/g, '$1')
    content = content.replace(/_([^_]+)_/g, '$1')

    return content
  }

  /**
   * Extract text from HTML (basic)
   */
  private static extractFromHtml(content: string): string {
    // Remove script and style tags completely
    content = content.replace(/<script[\s\S]*?<\/script>/gi, '')
    content = content.replace(/<style[\s\S]*?<\/style>/gi, '')

    // Remove HTML tags but keep content
    content = content.replace(/<[^>]+>/g, ' ')

    // Decode common HTML entities
    content = content.replace(/&lt;/g, '<')
    content = content.replace(/&gt;/g, '>')
    content = content.replace(/&amp;/g, '&')
    content = content.replace(/&quot;/g, '"')
    content = content.replace(/&#39;/g, "'")
    content = content.replace(/&nbsp;/g, ' ')

    return content
  }

  /**
   * Extract searchable text from JSON
   */
  private static extractFromJson(content: string): string {
    try {
      const obj = JSON.parse(content)
      return TextUtils.extractTextFromObject(obj)
    } catch {
      return content
    }
  }

  /**
   * Recursively extract text values from an object
   */
  private static extractTextFromObject(obj: any, depth = 0): string {
    if (depth > 10) return '' // Prevent infinite recursion

    if (typeof obj === 'string') {
      return obj + ' '
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj.toString() + ' '
    }

    if (Array.isArray(obj)) {
      return obj.map(item => TextUtils.extractTextFromObject(item, depth + 1)).join('')
    }

    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj)
        .map(value => TextUtils.extractTextFromObject(value, depth + 1))
        .join('')
    }

    return ''
  }

  /**
   * Clean text for embedding
   */
  static cleanTextForEmbedding(text: string): string {
    // Normalize horizontal whitespace only (preserve newlines)
    // Replace multiple spaces/tabs with single space, but keep newlines
    text = text.replace(/[ \t]+/g, ' ')

    // Normalize multiple consecutive newlines (keep max 2 for paragraph breaks)
    text = text.replace(/\n{3,}/g, '\n\n')

    // Remove excessive punctuation
    text = text.replace(/[.]{3,}/g, '...')
    text = text.replace(/[!]{2,}/g, '!')
    text = text.replace(/[?]{2,}/g, '?')

    // Trim and ensure minimum length
    text = text.trim()

    return text
  }
}