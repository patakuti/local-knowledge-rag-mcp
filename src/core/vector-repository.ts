import {
  SQL,
  and,
  count,
  eq,
  inArray,
  like,
  or,
  sql,
  sum,
} from 'drizzle-orm'
import { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type {
  EmbeddingDbStats,
  EmbeddingModelClient,
  InsertEmbedding,
  SelectEmbedding
} from '../types/rag.types.js'
import { embeddingTable } from '../database/schema.js'

export class VectorRepository {
  private db: NodePgDatabase
  private embeddingColumnType: 'vector' | 'jsonb' | null = null

  constructor(db: NodePgDatabase) {
    this.db = db
  }

  /**
   * Convert workspace_id string to a numeric lock key for PostgreSQL advisory locks
   * Uses a simple hash function to generate a consistent 32-bit integer
   */
  private workspaceIdToLockKey(workspaceId: string): number {
    let hash = 0
    for (let i = 0; i < workspaceId.length; i++) {
      const char = workspaceId.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash)
  }

  /**
   * Acquire an advisory lock for a workspace
   * This will block until the lock is available
   * Use this to prevent concurrent index updates across multiple server processes
   */
  async acquireAdvisoryLock(workspaceId: string): Promise<void> {
    const lockKey = this.workspaceIdToLockKey(workspaceId)
    console.error(`[VectorRepository] Acquiring advisory lock for workspace ${workspaceId} (key: ${lockKey})`)
    await this.db.execute(sql`SELECT pg_advisory_lock(${lockKey})`)
    console.error(`[VectorRepository] Advisory lock acquired for workspace ${workspaceId}`)
  }

  /**
   * Try to acquire an advisory lock for a workspace with a timeout
   * Returns true if lock was acquired, false if timeout occurred
   */
  async tryAcquireAdvisoryLock(workspaceId: string, timeoutMs: number = 5000): Promise<boolean> {
    const lockKey = this.workspaceIdToLockKey(workspaceId)
    console.error(`[VectorRepository] Trying to acquire advisory lock for workspace ${workspaceId} (key: ${lockKey}, timeout: ${timeoutMs}ms)`)

    const result = await this.db.execute(sql`
      SELECT pg_try_advisory_lock(${lockKey}) as acquired
    `)

    const acquired = (result.rows[0] as { acquired: boolean }).acquired

    if (acquired) {
      console.error(`[VectorRepository] Advisory lock acquired for workspace ${workspaceId}`)
      return true
    }

    console.error(`[VectorRepository] Failed to acquire advisory lock for workspace ${workspaceId}`)
    return false
  }

  /**
   * Release an advisory lock for a workspace
   */
  async releaseAdvisoryLock(workspaceId: string): Promise<void> {
    const lockKey = this.workspaceIdToLockKey(workspaceId)
    console.error(`[VectorRepository] Releasing advisory lock for workspace ${workspaceId} (key: ${lockKey})`)
    await this.db.execute(sql`SELECT pg_advisory_unlock(${lockKey})`)
    console.error(`[VectorRepository] Advisory lock released for workspace ${workspaceId}`)
  }

  /**
   * Execute a function within an advisory lock
   * Automatically acquires and releases the lock
   */
  async withAdvisoryLock<T>(
    workspaceId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.acquireAdvisoryLock(workspaceId)
    try {
      return await fn()
    } finally {
      await this.releaseAdvisoryLock(workspaceId)
    }
  }

  /**
   * Detect the data type of the embedding column
   * Returns 'vector' for pgvector type, 'jsonb' for legacy JSONB type
   */
  private async detectEmbeddingColumnType(): Promise<'vector' | 'jsonb'> {
    if (this.embeddingColumnType !== null) {
      return this.embeddingColumnType
    }

    try {
      const result = await this.db.execute(sql`
        SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'embeddings'
        AND column_name = 'embedding'
      `)

      const rows = result.rows as Array<{ data_type: string; udt_name: string }>
      if (rows.length === 0) {
        throw new Error('embedding column not found in embeddings table')
      }

      const { data_type, udt_name } = rows[0]

      // Check if it's a vector type (pgvector extension)
      if (udt_name === 'vector' || data_type === 'USER-DEFINED') {
        this.embeddingColumnType = 'vector'
        console.error('✓ Using pgvector native implementation for similarity search')
      } else if (data_type === 'jsonb') {
        this.embeddingColumnType = 'jsonb'
        console.warn('⚠ Using JSONB fallback for similarity search. Consider running migration: psql $DATABASE_URL -f scripts/migrate-to-pgvector.sql')
      } else {
        throw new Error(`Unsupported embedding column type: ${data_type} (${udt_name})`)
      }

      return this.embeddingColumnType
    } catch (error) {
      console.error('Failed to detect embedding column type:', error)
      throw error
    }
  }

  async getIndexedFilePaths(
    workspaceId: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<string[]> {
    const indexedFiles = await this.db
      .select({
        path: embeddingTable.path,
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
    return [...new Set(indexedFiles.map((row) => row.path))] // Remove duplicates
  }

  async getVectorsByFilePath(
    workspaceId: string,
    filePaths: string[],
    embeddingModel: EmbeddingModelClient,
  ): Promise<SelectEmbedding[]> {
    if (filePaths.length === 0) {
      return []
    }
    const results = await this.db
      .select()
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          inArray(embeddingTable.path, filePaths),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )

    // Filter out null embeddings
    return results.filter((result): result is SelectEmbedding =>
      result.embedding !== null
    ) as SelectEmbedding[]
  }

  async deleteVectorsForMultipleFiles(
    workspaceId: string,
    filePaths: string[],
    embeddingModel: EmbeddingModelClient,
  ): Promise<void> {
    if (filePaths.length === 0) {
      return
    }
    await this.db
      .delete(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          inArray(embeddingTable.path, filePaths),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
  }

  async insertVectors(vectors: InsertEmbedding[]): Promise<void> {
    if (vectors.length === 0) {
      return
    }
    await this.db.insert(embeddingTable).values(vectors)
  }

  async clearAllVectors(
    workspaceId: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<void> {
    await this.db
      .delete(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
  }

  async performSimilaritySearch(
    workspaceId: string,
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
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    const { minSimilarity, limit, scope } = options

    // Detect embedding column type
    const columnType = await this.detectEmbeddingColumnType()

    // Build where conditions
    const whereConditions: SQL<unknown>[] = [
      eq(embeddingTable.workspaceId, workspaceId),
      eq(embeddingTable.dimension, embeddingModel.dimension),
      eq(embeddingTable.model, embeddingModel.id),
      // Exclude skipped files (files with no indexable content)
      sql`(${embeddingTable.metadata}->>'skipped' IS NULL OR ${embeddingTable.metadata}->>'skipped' != 'true')`,
    ]

    // Add scope conditions
    if (scope?.files && scope.files.length > 0) {
      whereConditions.push(inArray(embeddingTable.path, scope.files))
    }

    // Note: scope.folders filtering is done in JavaScript after fetching
    // to support flexible glob patterns (convertFolderToGlob logic)

    if (columnType === 'vector') {
      // Use pgvector's cosine distance operator (<=>)
      return await this.performSimilaritySearchWithPgvector(
        queryEmbedding,
        whereConditions,
        minSimilarity,
        limit
      )
    } else {
      // Use JavaScript-based cosine similarity calculation (JSONB fallback)
      return await this.performSimilaritySearchWithJavaScript(
        queryEmbedding,
        whereConditions,
        minSimilarity,
        limit
      )
    }
  }

  /**
   * Similarity search using pgvector's native <=> operator (fast)
   */
  private async performSimilaritySearchWithPgvector(
    queryEmbedding: number[],
    whereConditions: SQL<unknown>[],
    minSimilarity: number,
    limit: number
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    // Cosine similarity = 1 - cosine distance
    const vectorString = JSON.stringify(queryEmbedding)

    // Build the query using pgvector's <=> operator
    const results = await this.db
      .select({
        id: embeddingTable.id,
        workspaceId: embeddingTable.workspaceId,
        path: embeddingTable.path,
        mtime: embeddingTable.mtime,
        content: embeddingTable.content,
        model: embeddingTable.model,
        dimension: embeddingTable.dimension,
        metadata: embeddingTable.metadata,
        distance: sql<number>`embedding <=> ${vectorString}::vector`.as('distance'),
      })
      .from(embeddingTable)
      .where(and(...whereConditions))
      .orderBy(sql`embedding <=> ${vectorString}::vector`)
      .limit(limit * 2) // Fetch more to account for similarity filtering

    // Convert distance to similarity and filter by minSimilarity
    const resultsWithSimilarity = results
      .map((row) => {
        // Cosine similarity = 1 - cosine distance
        const similarity = 1 - row.distance

        if (similarity < minSimilarity) {
          return null
        }

        const { distance, ...rest } = row
        return {
          ...rest,
          similarity
        }
      })
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .slice(0, limit)

    return resultsWithSimilarity
  }

  /**
   * Similarity search using JavaScript cosine similarity calculation (fallback for JSONB)
   */
  private async performSimilaritySearchWithJavaScript(
    queryEmbedding: number[],
    whereConditions: SQL<unknown>[],
    minSimilarity: number,
    limit: number
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    // Get all relevant embeddings from database
    const dbResults = await this.db
      .select()
      .from(embeddingTable)
      .where(and(...whereConditions))

    // Calculate cosine similarity in JavaScript
    const resultsWithSimilarity = dbResults
      .map((row) => {
        const embedding = row.embedding as number[]
        if (!embedding || !Array.isArray(embedding)) {
          return null
        }

        const similarity = this.calculateCosineSimilarity(queryEmbedding, embedding)

        if (similarity < minSimilarity) {
          return null
        }

        const { embedding: _, ...rest } = row
        return {
          ...rest,
          similarity
        }
      })
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)

    return resultsWithSimilarity
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private calculateCosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error('Vector dimensions must match')
    }

    let dotProduct = 0
    let magnitudeA = 0
    let magnitudeB = 0

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i]
      magnitudeA += vectorA[i] * vectorA[i]
      magnitudeB += vectorB[i] * vectorB[i]
    }

    magnitudeA = Math.sqrt(magnitudeA)
    magnitudeB = Math.sqrt(magnitudeB)

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0
    }

    return dotProduct / (magnitudeA * magnitudeB)
  }

  async getEmbeddingStats(workspaceId: string): Promise<EmbeddingDbStats[]> {
    const stats = await this.db
      .select({
        model: embeddingTable.model,
        rowCount: count().as('row_count'),
        totalDataBytes: sum(sql<number>`octet_length(${embeddingTable.content})`).as('total_data_bytes'),
      })
      .from(embeddingTable)
      .where(eq(embeddingTable.workspaceId, workspaceId))
      .groupBy(embeddingTable.model)

    return stats.map(stat => ({
      model: stat.model,
      rowCount: stat.rowCount,
      totalDataBytes: Number(stat.totalDataBytes) || 0
    }))
  }

  async getFileModificationTimes(
    workspaceId: string,
    filePaths: string[],
    embeddingModel: EmbeddingModelClient,
  ): Promise<Map<string, number>> {
    if (filePaths.length === 0) {
      return new Map()
    }

    const results = await this.db
      .select({
        path: embeddingTable.path,
        mtime: embeddingTable.mtime,
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          inArray(embeddingTable.path, filePaths),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )

    // Return the latest mtime for each file (in case of multiple chunks)
    const mtimeMap = new Map<string, number>()
    for (const result of results) {
      const currentMtime = mtimeMap.get(result.path) || 0
      if (result.mtime > currentMtime) {
        mtimeMap.set(result.path, result.mtime)
      }
    }
    return mtimeMap
  }

  async getTotalIndexedFiles(
    workspaceId: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<number> {
    const result = await this.db
      .select({
        count: sql<number>`COUNT(DISTINCT ${embeddingTable.path})`
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )

    return result[0]?.count || 0
  }

  async getTotalIndexedChunks(
    workspaceId: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<number> {
    const result = await this.db
      .select({
        count: count()
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )

    return result[0]?.count || 0
  }

  async getIndexedFiles(
    workspaceId: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<string[]> {
    const results = await this.db
      .selectDistinct({
        path: embeddingTable.path
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )

    return results.map(r => r.path)
  }

  async deleteVectorsForDeletedFiles(
    workspaceId: string,
    existingFilePaths: string[],
    embeddingModel: EmbeddingModelClient,
  ): Promise<void> {
    if (existingFilePaths.length === 0) {
      // If no files exist, delete all vectors for this model
      await this.clearAllVectors(workspaceId, embeddingModel)
      return
    }

    // Delete vectors for files that no longer exist
    // Create placeholders for existing file paths
    const placeholders = existingFilePaths.map((path) => `'${path.replace(/'/g, "''")}'`).join(',')
    const notInCondition = sql.raw(`${embeddingTable.path.name} NOT IN (${placeholders})`)

    await this.db
      .delete(embeddingTable)
      .where(
        and(
          eq(embeddingTable.workspaceId, workspaceId),
          eq(embeddingTable.model, embeddingModel.id),
          notInCondition
        )
      )
  }
}