import { z } from 'zod'

// ===== Core RAG Types =====

export type EmbeddingModelClient = {
  id: string
  dimension: number
  getEmbedding: (text: string) => Promise<number[]>
}

export type VectorMetaData = {
  startLine: number
  endLine: number
  // Skipped file metadata (when file has no indexable content)
  skipped?: boolean
  reason?: string
  originalSize?: number
}

export type SearchResult = {
  path: string
  content: string
  similarity: number
  metadata: VectorMetaData
  // Reference enhancement
  fileUri?: string
  lineRange?: { start: number; end: number }
  contextBefore?: string
  contextAfter?: string
}

export type EmbeddingDbStats = {
  model: string
  rowCount: number
  totalDataBytes: number
}

// ===== Configuration Types =====

export const embeddingModelConfigSchema = z.object({
  provider: z.enum(['openai', 'ollama', 'openai-compatible']),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  dimension: z.number()
})

export type EmbeddingModelConfig = z.infer<typeof embeddingModelConfigSchema>

export const chunkingConfigSchema = z.object({
  chunkSize: z.number().default(1000),
  chunkOverlap: z.number().default(200),
  language: z.string().default('markdown'),
  excludeCodeLanguages: z.array(z.string()).default([])
})

export type ChunkingConfig = z.infer<typeof chunkingConfigSchema>

export const searchConfigSchema = z.object({
  minSimilarity: z.number().default(0.7),
  maxResults: z.number().default(10),
  maxChunksPerQuery: z.number().default(5)
})

export type SearchConfig = z.infer<typeof searchConfigSchema>

export const reportConfigSchema = z.object({
  maxQuoteLines: z.number().default(5),
  removeBlankLines: z.boolean().default(true)
})

export type ReportConfig = z.infer<typeof reportConfigSchema>

export const indexingConfigSchema = z.object({
  includePatterns: z.array(z.string()).default(['*.md', '*.txt', '*.js', '*.ts', '*.py']),
  excludePatterns: z.array(z.string()).default(['node_modules/**', '.git/**', '*.min.*'])
})

export type IndexingConfig = z.infer<typeof indexingConfigSchema>

export const ragConfigSchema = z.object({
  embedding: embeddingModelConfigSchema,
  chunking: chunkingConfigSchema,
  search: searchConfigSchema,
  indexing: indexingConfigSchema,
  report: reportConfigSchema.optional()
})

export type RAGConfig = z.infer<typeof ragConfigSchema>

// ===== MCP Tool Types =====

export type VaultSearchParams = {
  query: string
  limit?: number
  minSimilarity?: number
  scope?: {
    files?: string[]
    folders?: string[]
  }
}

export type RebuildIndexParams = {
  reindexAll?: boolean
  reindex_all?: boolean // MCP compatibility
  progressCallback?: boolean
}

export type IndexStatusResult = {
  isInitialized: boolean
  totalFiles: number
  indexedFiles: number
  lastUpdated?: Date
  embeddingModel: string
  stats: EmbeddingDbStats[]
}

// ===== File System Types =====

export type FileInfo = {
  path: string
  stat: {
    mtime: number
    size: number
  }
}

export type ContentChunk = {
  path: string
  mtime: number
  content: string
  metadata: VectorMetaData
}

// ===== Progress Tracking =====

export type IndexProgress = {
  completedChunks: number
  totalChunks: number
  totalFiles: number
  currentFileName?: string
  completedFiles?: number
  waitingForRateLimit?: boolean
  isCancelled?: boolean
}

export type CancellationController = {
  isCancelled: boolean
  cancel: () => void
  reset: () => void
}

export type QueryProgressState =
  | { type: 'indexing'; indexProgress: IndexProgress }
  | { type: 'querying' }
  | { type: 'querying-done'; queryResult: SearchResult[] }

// ===== Database Types =====

// Re-export database types that will be used
export type SelectEmbedding = {
  id: number
  workspaceId: string
  path: string
  mtime: number
  content: string
  model: string
  dimension: number
  embedding: number[]
  metadata: VectorMetaData
}

export type InsertEmbedding = Omit<SelectEmbedding, 'id'>

// ===== Utility Types =====

export type ProviderType = 'openai' | 'ollama' | 'openai-compatible'

export type EmbeddingResponse = {
  embedding: number[]
  model: string
  usage?: {
    promptTokens: number
    totalTokens: number
  }
}

// ===== Session Management Types =====

export type SessionSearchResult = {
  id: string
  query: string
  timestamp: Date
  results: SearchResult[]
}

export type GenerateAnswerParams = {
  resultIds: string[]
  template?: string
  outputDir?: string
  fileName?: string
}

export type GenerateReportParams = {
  sessionId: string
  overallSummary: string
  sections: ReportSection[]
  template?: string
  outputDir?: string
  fileName?: string
}

export type ReportSection = {
  filePath: string
  summary: string
  quote: string
  startLine?: number
  endLine?: number
}

export type AnswerTemplate = {
  name: string
  description: string
  content: string
  metadata?: TemplateMetadata
}

export type TemplateMetadata = {
  name: string
  description: string
  language?: string
  variables: TemplateVariableSchema
  example?: Record<string, any>
}

export type TemplateVariableSchema = {
  [key: string]: TemplateVariableDefinition
}

export type TemplateVariableDefinition = {
  type: 'string' | 'array' | 'object'
  description: string
  required?: boolean
  items?: TemplateVariableDefinition
  properties?: TemplateVariableSchema
}

export type GetTemplateSchemaParams = {
  template?: string
}

export type GenerateAnswerParamsV2 = {
  template?: string
  variables: Record<string, any>
  resultIds?: string[]
  outputDir?: string
  fileName?: string
}

export type SessionManager = {
  searchResults: Map<string, SessionSearchResult>
  maxResults: number
  addSearchResult: (query: string, results: SearchResult[]) => string
  getSearchResult: (id: string) => SessionSearchResult | undefined
  listSearchResults: () => SessionSearchResult[]
  clearResults: () => void
}

// ===== Error Types =====

export class RAGError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'RAGError'
  }
}

export class EmbeddingError extends RAGError {
  constructor(message: string, public provider: string) {
    super(message, 'EMBEDDING_ERROR')
    this.name = 'EmbeddingError'
  }
}

export class IndexingError extends RAGError {
  constructor(message: string) {
    super(message, 'INDEXING_ERROR')
    this.name = 'IndexingError'
  }
}

export class SearchError extends RAGError {
  constructor(message: string) {
    super(message, 'SEARCH_ERROR')
    this.name = 'SearchError'
  }
}