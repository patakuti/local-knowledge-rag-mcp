import { backOff } from 'exponential-backoff'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import type {
  EmbeddingModelClient,
  IndexProgress,
  ContentChunk,
  InsertEmbedding,
  SearchResult,
  FileInfo,
  ChunkingConfig,
  CancellationController
} from '../types/rag.types.js'
import { EmbeddingError, IndexingError } from '../types/rag.types.js'
import { VectorRepository } from './vector-repository.js'
import { createEmbeddingsTableSQL, createVectorIndexSQL } from '../database/schema.js'
import { FileSystemUtils } from '../utils/file-utils.js'
import { TextChunker, TextUtils } from '../utils/chunk-utils.js'
import { ProgressLogger } from '../utils/progress-logger.js'
import { generateWorkspaceId } from '../utils/workspace-utils.js'
import { sanitizePath } from '../utils/log-sanitizer.js'
import path from 'path'

const { Pool } = pg

export class VectorManager {
  private repository: VectorRepository
  private fileUtils: FileSystemUtils
  private textChunker: TextChunker
  private chunkingConfig: ChunkingConfig
  private pool: pg.Pool
  private workspacePath: string
  private workspaceId: string
  private progressLogger: ProgressLogger

  constructor(
    workspacePath: string,
    chunkingConfig: ChunkingConfig,
    databaseUrl?: string
  ) {
    this.workspacePath = workspacePath
    this.workspaceId = generateWorkspaceId(workspacePath)
    this.chunkingConfig = chunkingConfig

    // Use DATABASE_URL environment variable or provided connection string
    const connectionString = databaseUrl || process.env.DATABASE_URL

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL environment variable is required for PostgreSQL connection. ' +
        'Example: postgresql://user:password@localhost:5432/dbname'
      )
    }

    this.pool = new Pool({ connectionString })
    const drizzleDb = drizzle(this.pool)

    this.repository = new VectorRepository(drizzleDb)
    this.fileUtils = new FileSystemUtils(workspacePath)
    this.textChunker = new TextChunker(chunkingConfig)
    this.progressLogger = new ProgressLogger(this.workspaceId)
  }

  async initialize(): Promise<void> {
    // Create database tables and indexes
    const client = await this.pool.connect()
    try {
      await client.query(createEmbeddingsTableSQL)
    } catch (error: any) {
      // Check if this is a "column does not exist" error (PostgreSQL error code 42703)
      // This indicates the table exists but is missing the workspace_id column
      if (error?.code === '42703' && error?.message?.includes('workspace_id')) {
        console.warn('⚠️  Database schema migration required')
        console.warn('')
        console.warn('The embeddings table is missing the workspace_id column.')
        console.warn('This column is required for multi-workspace support.')
        console.warn('')
        console.warn('To migrate your database, use the reinitialize_schema tool:')
        console.warn('')
        console.warn('  {')
        console.warn('    "tool": "reinitialize_schema",')
        console.warn('    "arguments": { "confirm": true }')
        console.warn('  }')
        console.warn('')
        console.warn('⚠️  Warning: This will delete all existing embeddings.')
        console.warn('')
        // Don't throw - allow server to continue running so user can call reinitialize_schema
      } else {
        // For other errors, rethrow
        throw error
      }
    } finally {
      client.release()
    }

    // Initialize progress logger
    await this.progressLogger.initialize()
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /**
   * Create vector similarity search index (HNSW)
   * Should be called after inserting significant amount of data
   */
  async createVectorIndex(dimension: number = 1536): Promise<void> {
    const client = await this.pool.connect()
    try {
      console.error('Creating HNSW vector index... This may take a few minutes.')
      await client.query(createVectorIndexSQL(dimension))
      console.error('Vector index created successfully.')
    } catch (error) {
      // If index already exists, that's okay
      if (error instanceof Error && error.message.includes('already exists')) {
        console.error('Vector index already exists.')
      } else {
        throw error
      }
    } finally {
      client.release()
    }
  }

  /**
   * Check if vector index exists
   */
  async hasVectorIndex(): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE indexname = 'embeddings_embedding_idx'
        ) as exists
      `)
      return result.rows[0]?.exists || false
    } finally {
      client.release()
    }
  }

  /**
   * Main method to update the vault index
   * Uses PostgreSQL advisory locks to prevent concurrent updates across multiple server processes
   */
  async updateVaultIndex(
    embeddingModel: EmbeddingModelClient,
    options: {
      includePatterns: string[]
      excludePatterns: string[]
      reindexAll?: boolean
    },
    updateProgress?: (indexProgress: IndexProgress) => void,
    cancellationController?: CancellationController,
  ): Promise<void> {
    // Wrap the entire update operation in an advisory lock
    // This prevents multiple servers from updating the same workspace simultaneously
    await this.repository.withAdvisoryLock(this.workspaceId, async () => {
      await this.updateVaultIndexInternal(
        embeddingModel,
        options,
        updateProgress,
        cancellationController
      )
    })
  }

  /**
   * Internal implementation of vault index update
   * This is called within an advisory lock to ensure exclusive access
   */
  private async updateVaultIndexInternal(
    embeddingModel: EmbeddingModelClient,
    options: {
      includePatterns: string[]
      excludePatterns: string[]
      reindexAll?: boolean
    },
    updateProgress?: (indexProgress: IndexProgress) => void,
    cancellationController?: CancellationController,
  ): Promise<void> {
    const startTime = Date.now()
    let filesToIndex: FileInfo[]

    try {
      if (options.reindexAll) {
        // Full reindex: get all files and clear existing vectors
        filesToIndex = await this.fileUtils.getFilesToIndex({
          includePatterns: options.includePatterns,
          excludePatterns: options.excludePatterns,
        })
        await this.repository.clearAllVectors(this.workspaceId, embeddingModel)
      } else {
        // Incremental update: clean up deleted files first
        await this.deleteVectorsForDeletedFiles(embeddingModel, options)

        // Get files that need indexing (new or modified)
        filesToIndex = await this.getFilesToIndex({
          embeddingModel,
          includePatterns: options.includePatterns,
          excludePatterns: options.excludePatterns,
        })

        // Remove existing vectors for files that will be reindexed
        if (filesToIndex.length > 0) {
          await this.repository.deleteVectorsForMultipleFiles(
            this.workspaceId,
            filesToIndex.map(file => file.path),
            embeddingModel,
          )
        }
      }

      if (filesToIndex.length === 0) {
        updateProgress?.({
          completedChunks: 0,
          totalChunks: 0,
          totalFiles: 0,
        })
        return
      }

      // Read and chunk files
      const { contentChunks, failedFiles, skippedFiles } = await this.prepareContentChunks(filesToIndex)

      // Check for cancellation after preparing chunks
      if (cancellationController?.isCancelled) {
        await this.progressLogger.logCancelled(0, contentChunks.length, filesToIndex.length, 0)
        updateProgress?.({
          completedChunks: 0,
          totalChunks: contentChunks.length,
          totalFiles: filesToIndex.length,
          completedFiles: 0,
          isCancelled: true,
        })
        return
      }

      // Record skipped files in database to prevent re-indexing attempts
      if (skippedFiles.length > 0) {
        const message = `Skipped ${skippedFiles.length} file(s) with no indexable content`
        const sanitizedPaths = skippedFiles.map(f => sanitizePath(f.path, this.workspacePath))
        console.warn(`[Indexing] ${message}: ${sanitizedPaths.join(', ')}`)

        // Create dummy embeddings for skipped files so they're marked as "processed"
        // This prevents them from appearing as "not indexed" in future updates
        await this.recordSkippedFiles(skippedFiles, filesToIndex, embeddingModel)
      }

      // Log failed files with details (this is an actual error)
      if (failedFiles.length > 0) {
        const message = `Failed to process ${failedFiles.length} file(s)`
        const sanitizedInfo = failedFiles.map(f => `${sanitizePath(f.path, this.workspacePath)} (${f.error})`)
        console.error(`[Indexing] ${message}: ${sanitizedInfo.join(', ')}`)
        await this.progressLogger.logWarning(message, {
          failedFiles: failedFiles.map(f => ({
            path: f.path,
            error: f.error,
            size: f.size
          }))
        })
      }

      if (contentChunks.length === 0) {
        const totalProcessed = filesToIndex.length
        const totalSkipped = skippedFiles.length
        const totalFailed = failedFiles.length

        // If all files were just skipped (no actual failures), this is not an error
        if (totalFailed === 0 && totalSkipped > 0) {
          console.warn(`[Indexing] All ${totalSkipped} file(s) were skipped (no indexable content). No indexing needed.`)
          await this.progressLogger.logComplete(0, 0, 0)
          return
        }

        // Otherwise, it's an error
        const errorDetails = {
          totalFiles: totalProcessed,
          skippedFiles: totalSkipped,
          failedFiles: totalFailed,
          details: {
            skipped: skippedFiles,
            failed: failedFiles
          }
        }
        const errorMessage = `All files failed to process. No content to index. (Total: ${totalProcessed}, Skipped: ${totalSkipped}, Failed: ${totalFailed})`
        console.error(`[Indexing] ${errorMessage}`)
        await this.progressLogger.logError(errorMessage)
        await this.progressLogger.logWarning('Index preparation failed', errorDetails)
        throw new IndexingError(errorMessage)
      }

      // Log start
      await this.progressLogger.logStart(contentChunks.length, filesToIndex.length)

      updateProgress?.({
        completedChunks: 0,
        totalChunks: contentChunks.length,
        totalFiles: filesToIndex.length,
        completedFiles: 0,
      })

      // Generate embeddings and save to database
      const result = await this.processEmbeddings(
        contentChunks,
        embeddingModel,
        filesToIndex.length,
        updateProgress,
        cancellationController
      )

      // Log completion only if not cancelled
      if (!result.wasCancelled) {
        const durationSeconds = (Date.now() - startTime) / 1000
        await this.progressLogger.logComplete(contentChunks.length, filesToIndex.length, durationSeconds)
      }
    } catch (error) {
      // Log error
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.progressLogger.logError(errorMessage)
      throw error
    }
  }

  /**
   * Perform similarity search
   */
  async performSimilaritySearch(
    queryEmbedding: number[],
    embeddingModel: EmbeddingModelClient,
    options: {
      minSimilarity: number
      limit: number
      scope?: {
        files?: string[]
        folders?: string[]
      }
    },
  ): Promise<SearchResult[]> {
    const results = await this.repository.performSimilaritySearch(
      this.workspaceId,
      queryEmbedding,
      embeddingModel,
      options
    )

    return results.map(result => ({
      path: result.path,
      content: result.content,
      similarity: result.similarity,
      metadata: result.metadata,
      // Reference enhancement
      fileUri: `file://${encodeURI(path.resolve(this.workspacePath, result.path).replace(/\\/g, '/'))}`,
      lineRange: {
        start: result.metadata.startLine,
        end: result.metadata.endLine
      }
    }))
  }

  /**
   * Get index statistics
   */
  async getIndexStats(embeddingModel: EmbeddingModelClient) {
    const stats = await this.repository.getEmbeddingStats(this.workspaceId)
    const totalFiles = await this.repository.getTotalIndexedFiles(this.workspaceId, embeddingModel)

    return {
      totalFiles,
      stats: stats.filter(stat => stat.model === embeddingModel.id),
      lastUpdated: new Date() // TODO: Track actual last update time
    }
  }

  /**
   * Record skipped files in database with dummy embeddings
   * This prevents them from appearing as "not indexed" in future updates
   */
  private async recordSkippedFiles(
    skippedFiles: Array<{ path: string; reason: string; size: number }>,
    allFiles: FileInfo[],
    embeddingModel: EmbeddingModelClient
  ): Promise<void> {
    if (skippedFiles.length === 0) return

    // Create a map of file paths to FileInfo for quick lookup
    const fileMap = new Map(allFiles.map(f => [f.path, f]))

    // Create dummy embeddings for skipped files
    const dummyEmbeddings: InsertEmbedding[] = skippedFiles
      .map(skipped => {
        const fileInfo = fileMap.get(skipped.path)
        if (!fileInfo) {
          const sanitized = sanitizePath(skipped.path, this.workspacePath)
          console.warn(`[recordSkippedFiles] FileInfo not found for ${sanitized}, skipping record`)
          return null
        }

        // Create a zero vector of the correct dimension
        const zeroVector = new Array(embeddingModel.dimension).fill(0)

        const embedding: InsertEmbedding = {
          workspaceId: this.workspaceId,
          path: skipped.path,
          mtime: fileInfo.stat.mtime,
          content: '[SKIPPED: No indexable content]',
          model: embeddingModel.id,
          dimension: embeddingModel.dimension,
          embedding: zeroVector,
          metadata: {
            startLine: 0,
            endLine: 0,
            skipped: true,
            reason: skipped.reason,
            originalSize: skipped.size
          }
        }
        return embedding
      })
      .filter((emb): emb is InsertEmbedding => emb !== null)

    if (dummyEmbeddings.length > 0) {
      await this.repository.insertVectors(dummyEmbeddings)
    }
  }

  /**
   * Get files that need indexing (new or modified files)
   */
  private async getFilesToIndex(options: {
    embeddingModel: EmbeddingModelClient
    includePatterns: string[]
    excludePatterns: string[]
  }): Promise<FileInfo[]> {
    // Get all files matching patterns
    const allFiles = await this.fileUtils.getFilesToIndex({
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
    })

    // Get currently indexed files with their modification times
    const indexedFilePaths = await this.repository.getIndexedFilePaths(this.workspaceId, options.embeddingModel)
    const indexedMtimes = await this.repository.getFileModificationTimes(
      this.workspaceId,
      indexedFilePaths,
      options.embeddingModel
    )

    // Filter to files that need reindexing
    return this.fileUtils.getFilesToReindex(allFiles, indexedMtimes)
  }

  /**
   * Remove vectors for files that no longer exist
   */
  private async deleteVectorsForDeletedFiles(
    embeddingModel: EmbeddingModelClient,
    options: {
      includePatterns: string[]
      excludePatterns: string[]
    }
  ): Promise<void> {
    const indexedFilePaths = await this.repository.getIndexedFilePaths(this.workspaceId, embeddingModel)
    const existingFilePaths = await this.fileUtils.filterExistingFiles(indexedFilePaths)

    // Also check if files still match the include/exclude patterns
    const currentFiles = await this.fileUtils.getFilesToIndex({
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
    })
    const currentFilePaths = new Set(currentFiles.map(f => f.path))

    const validFilePaths = existingFilePaths.filter(path => currentFilePaths.has(path))

    await this.repository.deleteVectorsForDeletedFiles(this.workspaceId, validFilePaths, embeddingModel)
  }

  /**
   * Read files and create content chunks
   */
  private async prepareContentChunks(files: FileInfo[]): Promise<{
    contentChunks: ContentChunk[]
    failedFiles: Array<{ path: string; error: string; size?: number }>
    skippedFiles: Array<{ path: string; reason: string; size: number }>
  }> {
    const failedFiles: Array<{ path: string; error: string; size?: number }> = []
    const skippedFiles: Array<{ path: string; reason: string; size: number }> = []
    const fileContents: Array<{ path: string; content: string; mtime: number }> = []

    // Read all files
    for (const file of files) {
      try {
        let content = await this.fileUtils.readFileContent(file.path)

        // Extract text content based on file type
        const ext = path.extname(file.path)
        content = TextUtils.extractTextContent(content, ext, this.chunkingConfig.excludeCodeLanguages)

        // Sanitize content
        content = this.fileUtils.sanitizeContent(content)
        content = TextUtils.cleanTextForEmbedding(content)

        if (content.trim().length === 0) {
          const reason = file.stat.size === 0
            ? 'File is empty (size: 0 bytes)'
            : 'File contains no indexable content after processing'
          skippedFiles.push({
            path: file.path,
            reason,
            size: file.stat.size
          })
          continue
        }

        fileContents.push({
          path: file.path,
          content,
          mtime: file.stat.mtime
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        failedFiles.push({
          path: file.path,
          error: errorMessage,
          size: file.stat.size,
        })
      }
    }

    // Create chunks for all files
    const contentChunks = await this.textChunker.createChunksForFiles(fileContents)
    const validChunks = this.textChunker.processChunks(contentChunks)

    return { contentChunks: validChunks, failedFiles, skippedFiles }
  }

  /**
   * Generate embeddings and save to database
   */
  private async processEmbeddings(
    contentChunks: ContentChunk[],
    embeddingModel: EmbeddingModelClient,
    totalFiles: number,
    updateProgress?: (indexProgress: IndexProgress) => void,
    cancellationController?: CancellationController
  ): Promise<{ wasCancelled: boolean }> {
    let completedChunks = 0
    const batchSize = 10 // Smaller batch size for better cancellation responsiveness
    const failedChunks: Array<{ path: string; error: string }> = []

    // Track completed files
    const processedFiles = new Set<string>()
    let lastProgressUpdate = Date.now()
    const progressThrottleMs = 500 // Update progress at most every 500ms

    // Process chunks in batches
    for (let i = 0; i < contentChunks.length; i += batchSize) {
      // Check for cancellation before processing each batch
      if (cancellationController?.isCancelled) {
        await this.progressLogger.logCancelled(completedChunks, contentChunks.length, totalFiles, processedFiles.size)
        const progress: IndexProgress = {
          completedChunks,
          totalChunks: contentChunks.length,
          totalFiles,
          completedFiles: processedFiles.size,
          isCancelled: true,
        }
        updateProgress?.(progress)
        return { wasCancelled: true }
      }

      const batch = contentChunks.slice(i, i + batchSize)

      const embeddingBatch: (InsertEmbedding | null)[] = await Promise.all(
        batch.map(async (chunk): Promise<InsertEmbedding | null> => {
          // Check for cancellation at the start of each chunk processing
          if (cancellationController?.isCancelled) {
            return null // Skip this chunk
          }

          try {
            return await backOff(
              async () => {
                // Check for cancellation before API call
                if (cancellationController?.isCancelled) {
                  throw new Error('Cancelled')
                }

                const embedding = await embeddingModel.getEmbedding(chunk.content)

                // Check for cancellation before updating progress counters
                if (cancellationController?.isCancelled) {
                  throw new Error('Cancelled')
                }

                completedChunks += 1
                processedFiles.add(chunk.path)

                // Throttle progress updates to avoid excessive callbacks
                const now = Date.now()
                if (now - lastProgressUpdate >= progressThrottleMs) {
                  lastProgressUpdate = now
                  const progress: IndexProgress = {
                    completedChunks,
                    totalChunks: contentChunks.length,
                    totalFiles,
                    currentFileName: path.basename(chunk.path),
                    completedFiles: processedFiles.size,
                  }
                  updateProgress?.(progress)
                  await this.progressLogger.logProgress(progress)
                }

                return {
                  workspaceId: this.workspaceId,
                  path: chunk.path,
                  mtime: chunk.mtime,
                  content: chunk.content,
                  model: embeddingModel.id,
                  dimension: embeddingModel.dimension,
                  embedding,
                  metadata: chunk.metadata,
                }
              },
              {
                numOfAttempts: 5,
                startingDelay: 1000,
                timeMultiple: 2,
                maxDelay: 30000,
                retry: async (error: any) => {
                  // Retry on rate limit errors
                  if (error.status === 429 || error instanceof EmbeddingError) {
                    const progress: IndexProgress = {
                      completedChunks,
                      totalChunks: contentChunks.length,
                      totalFiles,
                      currentFileName: path.basename(chunk.path),
                      completedFiles: processedFiles.size,
                      waitingForRateLimit: true,
                    }
                    updateProgress?.(progress)
                    await this.progressLogger.logProgress(progress)
                    return true
                  }
                  return false
                },
              },
            )
          } catch (error) {
            // Don't count cancellation as a failure
            if (error instanceof Error && error.message === 'Cancelled') {
              return null
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            failedChunks.push({
              path: chunk.path,
              error: errorMessage,
            })
            return null
          }
        })
      )

      // Check for cancellation after batch processing completes
      if (cancellationController?.isCancelled) {
        await this.progressLogger.logCancelled(completedChunks, contentChunks.length, totalFiles, processedFiles.size)
        const progress: IndexProgress = {
          completedChunks,
          totalChunks: contentChunks.length,
          totalFiles,
          completedFiles: processedFiles.size,
          isCancelled: true,
        }
        updateProgress?.(progress)
        return { wasCancelled: true }
      }

      // Filter out failed embeddings and insert valid ones
      const validEmbeddings = embeddingBatch.filter((emb): emb is InsertEmbedding => emb !== null)

      if (validEmbeddings.length > 0) {
        await this.repository.insertVectors(validEmbeddings)
      }

      // Check for cancellation one more time before sending progress update
      // This prevents sending inflated progress if cancellation happened during DB insert
      if (cancellationController?.isCancelled) {
        await this.progressLogger.logCancelled(completedChunks, contentChunks.length, totalFiles, processedFiles.size)
        const progress: IndexProgress = {
          completedChunks,
          totalChunks: contentChunks.length,
          totalFiles,
          completedFiles: processedFiles.size,
          isCancelled: true,
        }
        updateProgress?.(progress)
        return { wasCancelled: true }
      }

      // Send progress update at end of each batch
      const progress: IndexProgress = {
        completedChunks,
        totalChunks: contentChunks.length,
        totalFiles,
        completedFiles: processedFiles.size,
      }
      updateProgress?.(progress)
      await this.progressLogger.logProgress(progress)

      // Small delay between batches to be nice to APIs
      if (i + batchSize < contentChunks.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    if (failedChunks.length > 0) {
      const message = `Failed to embed ${failedChunks.length} out of ${contentChunks.length} chunks`
      const uniqueFailedPaths = [...new Set(failedChunks.map(f => f.path))]
      const sanitizedPaths = uniqueFailedPaths.map(p => sanitizePath(p, this.workspacePath))
      console.error(`[Indexing] ${message} from ${uniqueFailedPaths.length} file(s): ${sanitizedPaths.join(', ')}`)
      await this.progressLogger.logWarning(message, {
        failedChunks: failedChunks.map(f => ({
          path: f.path,
          error: f.error
        })),
        totalChunks: contentChunks.length,
        failedCount: failedChunks.length
      })
      throw new IndexingError(
        `${message}. Check API configuration and rate limits.`
      )
    }

    // Send final progress update
    const finalProgress: IndexProgress = {
      completedChunks,
      totalChunks: contentChunks.length,
      totalFiles,
      completedFiles: processedFiles.size,
    }
    updateProgress?.(finalProgress)
    await this.progressLogger.logProgress(finalProgress)

    return { wasCancelled: false }
  }

  getProgressLogger(): ProgressLogger {
    return this.progressLogger
  }

  getWorkspaceId(): string {
    return this.workspaceId
  }

  /**
   * Get the current vector dimension from the database schema
   */
  async getSchemaDimension(): Promise<number | null> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(`
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) as column_type
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        WHERE c.relname = 'embeddings'
        AND a.attname = 'embedding'
      `)

      if (result.rows.length === 0) {
        return null // Table doesn't exist yet
      }

      // Parse dimension from type string like "vector(768)"
      const columnType = result.rows[0].column_type
      const match = columnType.match(/vector\((\d+)\)/)

      if (!match) {
        return null // No dimension specified
      }

      return parseInt(match[1], 10)
    } finally {
      client.release()
    }
  }

  /**
   * Validate that schema dimension matches embedding model dimension
   * Returns an object with validation result and details
   */
  async validateSchemaDimension(
    embeddingDimension: number
  ): Promise<{
    valid: boolean
    schemaDimension: number | null
    embeddingDimension: number
    message?: string
  }> {
    const schemaDimension = await this.getSchemaDimension()

    if (schemaDimension === null) {
      return {
        valid: false,
        schemaDimension: null,
        embeddingDimension,
        message: 'Database schema not initialized. Please run schema initialization.'
      }
    }

    if (schemaDimension !== embeddingDimension) {
      return {
        valid: false,
        schemaDimension,
        embeddingDimension,
        message: `Schema dimension mismatch: database expects vector(${schemaDimension}), but embedding model produces ${embeddingDimension} dimensions.`
      }
    }

    return {
      valid: true,
      schemaDimension,
      embeddingDimension
    }
  }

  /**
   * Reinitialize embeddings for this workspace
   * WARNING: This will delete all existing embeddings for this workspace only
   * Other workspaces are not affected
   */
  async reinitializeSchema(embeddingModel: EmbeddingModelClient): Promise<void> {
    console.error(`Reinitializing embeddings for workspace ${this.workspaceId}...`)
    console.error(`  - Model: ${embeddingModel.id}`)
    console.error(`  - Dimension: ${embeddingModel.dimension}`)

    // Delete all vectors for this workspace
    await this.repository.clearAllVectors(this.workspaceId, embeddingModel)

    console.error(`✓ All embeddings deleted for workspace ${this.workspaceId}`)
    console.error(`✓ Other workspaces are not affected`)
  }

  /**
   * Get project statistics including file counts
   */
  async getProjectStatistics(
    embeddingModel: EmbeddingModelClient,
    includePatterns: string[],
    excludePatterns: string[]
  ): Promise<{
    totalFilesInProject: number
    indexedFiles: number
    notIndexedFiles: number
    deletedFiles: number
  }> {
    // Get all indexable files (with FileInfo including size)
    // This ensures consistency with the indexing logic
    const allFileInfos = await this.fileUtils.getFilesToIndex({
      includePatterns,
      excludePatterns
    })

    // Filter out empty files (same logic as getFilesToReindex)
    // Empty files are not indexed, so they should not be counted in statistics
    const indexableFiles = allFileInfos.filter(file => file.stat.size > 0)
    const indexableFilePaths = indexableFiles.map(f => f.path)
    const totalFilesInProject = indexableFiles.length

    // Get indexed files from database
    const indexedFiles = await this.repository.getTotalIndexedFiles(this.workspaceId, embeddingModel)

    // Get indexed file paths from database
    const indexedFilePaths = await this.repository.getIndexedFiles(this.workspaceId, embeddingModel)

    // Count deleted files (in DB but not in filesystem or no longer indexable)
    let deletedFiles = 0
    for (const dbPath of indexedFilePaths) {
      if (!indexableFilePaths.includes(dbPath)) {
        deletedFiles++
      }
    }

    const notIndexedFiles = totalFilesInProject - (indexedFiles - deletedFiles)

    return {
      totalFilesInProject,
      indexedFiles,
      notIndexedFiles,
      deletedFiles
    }
  }
}