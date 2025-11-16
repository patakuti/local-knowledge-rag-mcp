import type {
  RAGConfig,
  ChunkingConfig,
  SearchConfig,
  IndexingConfig,
  ReportConfig,
} from '../types/rag.types.js'
import { loadEmbeddingConfigFromEnv } from './embedding-config-loader.js'
import { getEmbeddingModelConfig } from './embedding-client.js'

/**
 * Load complete RAG configuration from environment variables
 *
 * @returns Complete RAG configuration
 */
export function loadRAGConfigFromEnv(): RAGConfig {
  // Load embedding configuration
  const embeddingConfig = loadEmbeddingConfigFromEnv()
  const embeddingModelConfig = getEmbeddingModelConfig(
    embeddingConfig.model,
    embeddingConfig.apiKey,
    embeddingConfig.baseUrl
  )

  // Load other RAG configurations from environment variables
  const chunkingConfig = loadChunkingConfigFromEnv()
  const searchConfig = loadSearchConfigFromEnv()
  const indexingConfig = loadIndexingConfigFromEnv()
  const reportConfig = loadReportConfigFromEnv()

  return {
    embedding: embeddingModelConfig,
    chunking: chunkingConfig,
    search: searchConfig,
    indexing: indexingConfig,
    report: reportConfig,
  }
}

/**
 * Load chunking configuration from environment variables
 */
function loadChunkingConfigFromEnv(): ChunkingConfig {
  // Default languages to exclude from markdown code blocks
  const defaultExcludeLanguages = [
    'javascript', 'js', 'jsx',
    'typescript', 'ts', 'tsx',
    'python', 'py',
    'java', 'kotlin', 'scala',
    'c', 'cpp', 'c++', 'cxx', 'cc', 'h', 'hpp',
    'csharp', 'cs',
    'ruby', 'rb',
    'php',
    'go', 'golang',
    'rust', 'rs',
    'swift',
    'perl',
    'lua',
    'r',
    'matlab',
    'dot', 'graphviz'
  ]

  return {
    chunkSize: process.env.RAG_CHUNK_SIZE ? parseInt(process.env.RAG_CHUNK_SIZE) : 1000,
    chunkOverlap: process.env.RAG_CHUNK_OVERLAP ? parseInt(process.env.RAG_CHUNK_OVERLAP) : 200,
    language: process.env.RAG_CHUNK_LANGUAGE || 'markdown',
    excludeCodeLanguages: process.env.RAG_EXCLUDE_CODE_LANGUAGES
      ? process.env.RAG_EXCLUDE_CODE_LANGUAGES.split(',').map(s => s.trim().toLowerCase())
      : defaultExcludeLanguages,
  }
}

/**
 * Load search configuration from environment variables
 */
function loadSearchConfigFromEnv(): SearchConfig {
  return {
    minSimilarity: process.env.RAG_MIN_SIMILARITY ? parseFloat(process.env.RAG_MIN_SIMILARITY) : 0.7,
    maxResults: process.env.RAG_MAX_RESULTS ? parseInt(process.env.RAG_MAX_RESULTS) : 10,
    maxChunksPerQuery: process.env.RAG_MAX_CHUNKS_PER_QUERY ? parseInt(process.env.RAG_MAX_CHUNKS_PER_QUERY) : 5,
  }
}

/**
 * Load indexing configuration from environment variables
 */
function loadIndexingConfigFromEnv(): IndexingConfig {
  const defaultInclude = [
    '**/*.md', '**/*.txt'
  ]

  // Get report output directory from environment variable (default: rag-reports)
  // Exclude the directory at any nesting level to support nested workspaces
  const reportOutputDir = process.env.RAG_REPORT_OUTPUT_DIR || 'rag-reports'
  const reportExcludePattern = `**/${reportOutputDir}/**`

  const defaultExclude = [
    'node_modules/**', '.git/**', '*.min.*', 'dist/**', 'build/**',
    '.next/**', '.cache/**', 'coverage/**', '.nyc_output/**',
    '**/*.log', '**/logs/**', '**/.DS_Store', '**/Thumbs.db',
    reportExcludePattern
  ]

  return {
    includePatterns: process.env.RAG_INCLUDE_PATTERNS
      ? process.env.RAG_INCLUDE_PATTERNS.split(',').map(s => s.trim())
      : defaultInclude,
    excludePatterns: process.env.RAG_EXCLUDE_PATTERNS
      ? process.env.RAG_EXCLUDE_PATTERNS.split(',').map(s => s.trim())
      : defaultExclude,
  }
}

/**
 * Load report configuration from environment variables
 */
function loadReportConfigFromEnv(): ReportConfig {
  return {
    maxQuoteLines: process.env.RAG_MAX_QUOTE_LINES ? parseInt(process.env.RAG_MAX_QUOTE_LINES) : 5,
    removeBlankLines: process.env.RAG_REMOVE_BLANK_LINES !== 'false', // default true
  }
}
