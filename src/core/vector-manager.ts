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
import { createEmbeddingsTableSQL, createVectorIndexSQL, dropVectorIndexSQL } from '../database/schema.js'
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
   * Drop vector similarity search index (HNSW)
   * Used before bulk inserts to avoid per-row HNSW index maintenance overhead
   */
  async dropVectorIndex(): Promise<void> {
    const client = await this.pool.connect()
    try {
      console.error('Dropping HNSW vector index for bulk insert performance...')
      await client.query(dropVectorIndexSQL)
      console.error('Vector index dropped.')
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

    console.error(`[updateVaultIndex] Starting ${options.reindexAll ? 'full' : 'incremental'} index update`)

    try {
      if (options.reindexAll) {
        // Full reindex: get all files and clear existing vectors
        console.error('[updateVaultIndex] Scanning files for full reindex...')
        filesToIndex = await this.fileUtils.getFilesToIndex({
          includePatterns: options.includePatterns,
          excludePatterns: options.excludePatterns,
        })
        console.error(`[updateVaultIndex] Found ${filesToIndex.length} files to index`)
        if (cancellationController?.isCancelled) {
          await this.progressLogger.logCancelled(0, 0, 0, 0)
          updateProgress?.({ completedChunks: 0, totalChunks: 0, totalFiles: 0, isCancelled: true })
          return
        }
        console.error('[updateVaultIndex] Clearing all existing vectors...')
        await this.repository.clearAllVectors(this.workspaceId, embeddingModel)
        console.error('[updateVaultIndex] Cleared all existing vectors')
      } else {
        // Incremental update: clean up deleted files first
        console.error('[updateVaultIndex] Deleting vectors for removed files...')
        await this.deleteVectorsForDeletedFiles(embeddingModel, options)
        console.error('[updateVaultIndex] Deleted vectors for removed files')

        if (cancellationController?.isCancelled) {
          await this.progressLogger.logCancelled(0, 0, 0, 0)
          updateProgress?.({ completedChunks: 0, totalChunks: 0, totalFiles: 0, isCancelled: true })
          return
        }

        // Get files that need indexing (new or modified)
        console.error('[updateVaultIndex] Scanning files for incremental update...')
        filesToIndex = await this.getFilesToIndex({
          embeddingModel,
          includePatterns: options.includePatterns,
          excludePatterns: options.excludePatterns,
        })
        console.error(`[updateVaultIndex] Found ${filesToIndex.length} files to index`)

        if (cancellationController?.isCancelled) {
          await this.progressLogger.logCancelled(0, 0, 0, 0)
          updateProgress?.({ completedChunks: 0, totalChunks: 0, totalFiles: 0, isCancelled: true })
          return
        }

        // Remove existing vectors for files that will be reindexed
        if (filesToIndex.length > 0) {
          console.error(`[updateVaultIndex] Removing existing vectors for ${filesToIndex.length} files...`)
          await this.repository.deleteVectorsForMultipleFiles(
            this.workspaceId,
            filesToIndex.map(file => file.path),
            embeddingModel,
          )
          console.error('[updateVaultIndex] Removed existing vectors')
        }
      }

      if (filesToIndex.length === 0) {
        console.error('[updateVaultIndex] No files to index, completing early')
        const durationSeconds = (Date.now() - startTime) / 1000
        await this.progressLogger.logComplete(0, 0, durationSeconds)
        updateProgress?.({
          completedChunks: 0,
          totalChunks: 0,
          totalFiles: 0,
        })
        return
      }

      // Read and chunk files
      console.error(`[updateVaultIndex] Preparing content chunks for ${filesToIndex.length} files...`)
      const { contentChunks, failedFiles, skippedFiles } = await this.prepareContentChunks(filesToIndex)
      console.error(`[updateVaultIndex] Prepared ${contentChunks.length} chunks (${failedFiles.length} failed, ${skippedFiles.length} skipped)`)

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
      console.error(`[updateVaultIndex] Starting embedding generation for ${contentChunks.length} chunks from ${filesToIndex.length} files`)
      await this.progressLogger.logStart(contentChunks.length, filesToIndex.length)

      updateProgress?.({
        completedChunks: 0,
        totalChunks: contentChunks.length,
        totalFiles: filesToIndex.length,
        completedFiles: 0,
      })

      // Drop HNSW index before bulk inserts to avoid per-row index maintenance overhead.
      // The index is recreated after all inserts complete (or on cancellation/error).
      const BULK_INSERT_THRESHOLD = 100
      const shouldManageIndex = contentChunks.length >= BULK_INSERT_THRESHOLD
      let droppedIndex = false

      if (shouldManageIndex) {
        console.error(`[updateVaultIndex] Checking HNSW index for bulk insert (${contentChunks.length} chunks >= ${BULK_INSERT_THRESHOLD} threshold)...`)
        if (await this.hasVectorIndex()) {
          await this.dropVectorIndex()
          droppedIndex = true
        } else {
          console.error('[updateVaultIndex] No HNSW index to drop')
        }
      }

      try {
        // Generate embeddings and save to database
        console.error('[updateVaultIndex] Starting processEmbeddings...')
        const result = await this.processEmbeddings(
          contentChunks,
          embeddingModel,
          filesToIndex.length,
          updateProgress,
          cancellationController
        )
        console.error(`[updateVaultIndex] processEmbeddings completed (wasCancelled: ${result.wasCancelled})`)

        // Log completion only if not cancelled
        if (!result.wasCancelled) {
          const durationSeconds = (Date.now() - startTime) / 1000
          console.error(`[updateVaultIndex] Index update completed in ${durationSeconds.toFixed(1)}s`)
          await this.progressLogger.logComplete(contentChunks.length, filesToIndex.length, durationSeconds)
        }
      } finally {
        // Always recreate the HNSW index if we dropped it
        if (droppedIndex) {
          console.error('[updateVaultIndex] Recreating HNSW vector index after bulk insert...')
          await this.createVectorIndex(embeddingModel.dimension)
        }
      }
    } catch (error) {
      // Log error
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[updateVaultIndex] Error: ${errorMessage}`)
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
    console.error('[getFilesToIndex] Scanning filesystem for matching files...')
    const allFiles = await this.fileUtils.getFilesToIndex({
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
    })
    console.error(`[getFilesToIndex] Found ${allFiles.length} files matching patterns`)

    // Get currently indexed files with their modification times
    console.error('[getFilesToIndex] Querying indexed file paths from database...')
    const indexedFilePaths = await this.repository.getIndexedFilePaths(this.workspaceId, options.embeddingModel)
    console.error(`[getFilesToIndex] Found ${indexedFilePaths.length} indexed files in database`)

    console.error('[getFilesToIndex] Querying file modification times...')
    const indexedMtimes = await this.repository.getFileModificationTimes(
      this.workspaceId,
      indexedFilePaths,
      options.embeddingModel
    )
    console.error(`[getFilesToIndex] Got ${indexedMtimes.size} modification times`)

    // Filter to files that need reindexing
    const filesToReindex = await this.fileUtils.getFilesToReindex(allFiles, indexedMtimes)
    console.error(`[getFilesToIndex] ${filesToReindex.length} files need (re)indexing`)
    return filesToReindex
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
    console.error('[deleteVectorsForDeletedFiles] Querying indexed file paths...')
    const indexedFilePaths = await this.repository.getIndexedFilePaths(this.workspaceId, embeddingModel)
    console.error(`[deleteVectorsForDeletedFiles] Found ${indexedFilePaths.length} indexed files`)

    console.error('[deleteVectorsForDeletedFiles] Filtering existing files...')
    const existingFilePaths = await this.fileUtils.filterExistingFiles(indexedFilePaths)
    console.error(`[deleteVectorsForDeletedFiles] ${existingFilePaths.length} of ${indexedFilePaths.length} indexed files still exist`)

    // Also check if files still match the include/exclude patterns
    console.error('[deleteVectorsForDeletedFiles] Scanning current files matching patterns...')
    const currentFiles = await this.fileUtils.getFilesToIndex({
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
    })
    const currentFilePaths = new Set(currentFiles.map(f => f.path))
    console.error(`[deleteVectorsForDeletedFiles] ${currentFilePaths.size} current files match patterns`)

    const validFilePaths = existingFilePaths.filter(path => currentFilePaths.has(path))
    console.error(`[deleteVectorsForDeletedFiles] ${validFilePaths.length} valid files, deleting vectors for removed files...`)

    await this.repository.deleteVectorsForDeletedFiles(this.workspaceId, validFilePaths, embeddingModel)
    console.error('[deleteVectorsForDeletedFiles] Done')
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
    console.error(`[prepareContentChunks] Reading ${files.length} files...`)
    let readCount = 0
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
      readCount++
      if (readCount % 500 === 0) {
        console.error(`[prepareContentChunks] Read ${readCount}/${files.length} files (${fileContents.length} valid, ${skippedFiles.length} skipped, ${failedFiles.length} failed)`)
      }
    }
    console.error(`[prepareContentChunks] File reading complete: ${fileContents.length} valid, ${skippedFiles.length} skipped, ${failedFiles.length} failed`)

    // Create chunks for all files
    console.error(`[prepareContentChunks] Creating chunks for ${fileContents.length} files...`)
    const contentChunks = await this.textChunker.createChunksForFiles(fileContents)
    console.error(`[prepareContentChunks] Created ${contentChunks.length} chunks, processing...`)
    const validChunks = this.textChunker.processChunks(contentChunks)
    console.error(`[prepareContentChunks] ${validChunks.length} valid chunks after processing`)

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
    const batchSize = 50
    const failedChunks: Array<{ path: string; error: string }> = []

    // Track completed files
    const processedFiles = new Set<string>()
    let lastProgressUpdate = Date.now()
    const progressThrottleMs = 500 // Update progress at most every 500ms

    // Pipeline: overlap embedding generation with DB insertion
    let pendingInsert: Promise<void> | null = null

    // Helper to check and handle cancellation
    const checkCancelled = async (): Promise<boolean> => {
      if (!cancellationController?.isCancelled) return false
      // Wait for any pending DB insert to complete before reporting cancellation
      if (pendingInsert) {
        await pendingInsert
        pendingInsert = null
      }
      await this.progressLogger.logCancelled(completedChunks, contentChunks.length, totalFiles, processedFiles.size)
      const progress: IndexProgress = {
        completedChunks,
        totalChunks: contentChunks.length,
        totalFiles,
        completedFiles: processedFiles.size,
        isCancelled: true,
      }
      updateProgress?.(progress)
      return true
    }

    // Process chunks in batches
    for (let i = 0; i < contentChunks.length; i += batchSize) {
      // Check for cancellation before processing each batch
      if (await checkCancelled()) return { wasCancelled: true }

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
                  // Stop retrying if cancelled
                  if (cancellationController?.isCancelled) return false
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

      // Check for cancellation after batch embedding completes
      if (await checkCancelled()) return { wasCancelled: true }

      // Wait for previous batch's DB insert to complete before starting a new one
      if (pendingInsert) {
        await pendingInsert
        pendingInsert = null
      }

      // Filter out failed embeddings and start DB insert in background (pipelined)
      const validEmbeddings = embeddingBatch.filter((emb): emb is InsertEmbedding => emb !== null)

      if (validEmbeddings.length > 0) {
        pendingInsert = this.repository.insertVectors(validEmbeddings)
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
    }

    // Wait for the final DB insert to complete
    if (pendingInsert) {
      await pendingInsert
      pendingInsert = null
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
    const indexableFilePathSet = new Set(indexableFiles.map(f => f.path))
    const totalFilesInProject = indexableFiles.length

    // Get indexed files from database (run both queries in parallel)
    const [indexedFiles, indexedFilePaths] = await Promise.all([
      this.repository.getTotalIndexedFiles(this.workspaceId, embeddingModel),
      this.repository.getIndexedFiles(this.workspaceId, embeddingModel)
    ])

    // Count deleted files (in DB but not in filesystem or no longer indexable)
    let deletedFiles = 0
    for (const dbPath of indexedFilePaths) {
      if (!indexableFilePathSet.has(dbPath)) {
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