import type {
  EmbeddingModelClient,
  RAGConfig,
  SearchResult,
  IndexProgress,
  QueryProgressState,
  IndexStatusResult,
  VaultSearchParams,
  RebuildIndexParams,
  CancellationController
} from '../types/rag.types.js'
import { VectorManager } from './vector-manager.js'
import { createEmbeddingClient, getEmbeddingModelConfig } from './embedding-client.js'
import path from 'path'

export class RAGEngine {
  private vectorManager: VectorManager
  private embeddingModel: EmbeddingModelClient
  private config: RAGConfig
  private workspacePath: string

  constructor(workspacePath: string, config: RAGConfig, databaseUrl?: string) {
    this.workspacePath = workspacePath
    this.config = config
    this.embeddingModel = createEmbeddingClient(config.embedding)
    this.vectorManager = new VectorManager(workspacePath, config.chunking, databaseUrl)
  }

  /**
   * Initialize the RAG engine
   */
  async initialize(): Promise<void> {
    // Initialize vector manager
    await this.vectorManager.initialize()

    // Validate schema dimension matches embedding model
    await this.validateSchemaDimension()
  }

  /**
   * Validate that database schema dimension matches embedding model dimension
   * Logs warning if there's a mismatch
   */
  private async validateSchemaDimension(): Promise<void> {
    try {
      const validation = await this.vectorManager.validateSchemaDimension(this.embeddingModel.dimension)

      if (!validation.valid) {
        const warning = [
          '',
          '⚠️  ========================================',
          '⚠️  SCHEMA DIMENSION MISMATCH DETECTED',
          '⚠️  ========================================',
          '',
          validation.message || 'Unknown validation error',
          '',
          'Details:',
          `  - Database schema: ${validation.schemaDimension !== null ? `vector(${validation.schemaDimension})` : 'Not initialized'}`,
          `  - Embedding model: ${this.embeddingModel.id} (${validation.embeddingDimension} dimensions)`,
          '',
          'Action required:',
          '  1. Use MCP tool: reinitialize_schema with confirm=true',
          '  2. Or visit http://localhost:3456 (if progress server is enabled)',
          '',
          'Example:',
          '  {',
          '    "tool": "reinitialize_schema",',
          '    "arguments": { "confirm": true }',
          '  }',
          '',
          '⚠️  ========================================',
          ''
        ].join('\n')

        console.warn(warning)
      }
    } catch (error: any) {
      // Check if this is a workspace_id column error
      if (error?.code === '42703' || (error?.message && error.message.includes('workspace_id'))) {
        // Already handled by VectorManager.initialize() - skip duplicate warning
        return
      }
      // Don't fail initialization if validation check fails
      console.error('Failed to validate schema dimension:', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    await this.vectorManager.close()
  }

  /**
   * Update configuration
   */
  updateConfig(config: RAGConfig): void {
    this.config = config
    this.embeddingModel = createEmbeddingClient(config.embedding)
    // Note: VectorManager chunking config cannot be changed without recreating
    // This is a limitation we accept for simplicity
  }

  /**
   * Update the vault index (main indexing method)
   */
  async updateVaultIndex(
    options: RebuildIndexParams = {},
    onProgressChange?: (progress: QueryProgressState) => void,
    cancellationController?: CancellationController,
  ): Promise<void> {
    const { reindexAll = false } = options

    await this.vectorManager.updateVaultIndex(
      this.embeddingModel,
      {
        includePatterns: this.config.indexing.includePatterns,
        excludePatterns: this.config.indexing.excludePatterns,
        reindexAll,
      },
      (indexProgress) => {
        onProgressChange?.({
          type: 'indexing',
          indexProgress,
        })
      },
      cancellationController,
    )
  }

  /**
   * Process a search query
   */
  async processQuery(params: VaultSearchParams): Promise<SearchResult[]> {
    const {
      query,
      limit = this.config.search.maxResults,
      minSimilarity = this.config.search.minSimilarity,
      scope
    } = params

    // Get query embedding
    const queryEmbedding = await this.embeddingModel.getEmbedding(query)

    // Perform similarity search
    let results = await this.vectorManager.performSimilaritySearch(
      queryEmbedding,
      this.embeddingModel,
      {
        minSimilarity,
        limit,
        scope: {
          files: scope?.files,
          // Note: folders will be filtered in vectorManager
          folders: undefined,
        },
      },
    )

    // Apply scope.folders filtering with glob patterns
    if (scope?.folders && scope.folders.length > 0) {
      const { filterByFolders } = await import('../utils/folder-utils.js')
      results = filterByFolders(results, scope.folders)
    }

    return results
  }

  /**
   * Get index status and statistics
   */
  async getIndexStatus(): Promise<IndexStatusResult> {
    try {
      const stats = await this.vectorManager.getIndexStats(this.embeddingModel)

      return {
        isInitialized: true,
        totalFiles: stats.totalFiles,
        indexedFiles: stats.totalFiles, // All indexed files are counted
        lastUpdated: stats.lastUpdated,
        embeddingModel: this.embeddingModel.id,
        stats: stats.stats
      }
    } catch (error) {
      return {
        isInitialized: false,
        totalFiles: 0,
        indexedFiles: 0,
        embeddingModel: this.embeddingModel.id,
        stats: []
      }
    }
  }

  /**
   * Search with automatic index update
   */
  async searchWithAutoUpdate(
    params: VaultSearchParams,
    onProgressChange?: (progress: QueryProgressState) => void
  ): Promise<SearchResult[]> {
    // Update index incrementally before searching
    await this.updateVaultIndex({ reindexAll: false }, onProgressChange)

    // Signal querying phase
    onProgressChange?.({ type: 'querying' })

    // Perform search
    const results = await this.processQuery(params)

    // Signal completion
    onProgressChange?.({
      type: 'querying-done',
      queryResult: results
    })

    return results
  }

  /**
   * Get embedding for a query (useful for debugging)
   */
  async getQueryEmbedding(query: string): Promise<number[]> {
    return await this.embeddingModel.getEmbedding(query)
  }

  /**
   * Get current configuration
   */
  getConfig(): RAGConfig {
    return { ...this.config }
  }

  /**
   * Get workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath
  }

  /**
   * Get embedding model info
   */
  getEmbeddingModelInfo(): {
    id: string
    dimension: number
    provider: string
  } {
    return {
      id: this.embeddingModel.id,
      dimension: this.embeddingModel.dimension,
      provider: this.config.embedding.provider
    }
  }

  getVectorManager(): VectorManager {
    return this.vectorManager
  }

  getEmbeddingModel(): EmbeddingModelClient {
    return this.embeddingModel
  }
}

/**
 * Factory function to create RAG engine with default config
 */
export async function createRAGEngine(
  workspacePath: string,
  embeddingModelId: string = 'openai-text-embedding-3-small',
  options: {
    apiKey?: string
    baseUrl?: string
    chunkSize?: number
    includePatterns?: string[]
    excludePatterns?: string[]
    databaseUrl?: string
  } = {}
): Promise<RAGEngine> {
  const embeddingConfig = getEmbeddingModelConfig(
    embeddingModelId,
    options.apiKey,
    options.baseUrl
  )

  // Get report output directory from environment variable (default: rag-reports)
  // Exclude the directory at any nesting level to support nested workspaces
  const reportOutputDir = process.env.RAG_REPORT_OUTPUT_DIR || 'rag-reports'
  const reportExcludePattern = `**/${reportOutputDir}/**`

  const config: RAGConfig = {
    embedding: embeddingConfig,
    chunking: {
      chunkSize: options.chunkSize || 1000,
      chunkOverlap: 200,
      language: 'markdown',
      excludeCodeLanguages: []
    },
    search: {
      minSimilarity: 0.7,
      maxResults: 10,
      maxChunksPerQuery: 5
    },
    indexing: {
      includePatterns: options.includePatterns || [
        '**/*.md', '**/*.txt', '**/*.js', '**/*.ts', '**/*.tsx', '**/*.jsx',
        '**/*.py', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml',
        '**/*.ini', '**/*.cfg', '**/*.conf', '**/*.rst', '**/*.adoc'
      ],
      excludePatterns: options.excludePatterns || [
        'node_modules/**', '.git/**', '*.min.*', 'dist/**', 'build/**',
        '.next/**', '.cache/**', 'coverage/**', '.nyc_output/**',
        '**/*.log', '**/logs/**', '**/.DS_Store', '**/Thumbs.db',
        reportExcludePattern
      ]
    }
  }

  const engine = new RAGEngine(workspacePath, config, options.databaseUrl)
  await engine.initialize()

  return engine
}

/**
 * Create RAG engine from config
 *
 * Configuration priority:
 * 1. Database workspace_settings (custom settings for this workspace)
 * 2. Environment variables (server-wide default settings)
 * 3. Default values
 */
export async function createRAGEngineFromConfig(
  workspacePath: string,
  _configPath?: string
): Promise<RAGEngine> {
  const databaseUrl = process.env.DATABASE_URL

  // Load complete RAG configuration (embedding, chunking, search, indexing, report)
  const { loadRAGConfigFromEnv } = await import('./rag-config-loader.js')
  const config = loadRAGConfigFromEnv()

  // Create RAG engine with loaded configuration
  const engine = new RAGEngine(workspacePath, config, databaseUrl)
  await engine.initialize()

  return engine
}