/**
 * Database schema for vector embeddings storage
 *
 * Originally sourced from Obsidian Smart Composer
 * https://github.com/glowingjade/obsidian-smart-composer
 */

import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  customType,
} from 'drizzle-orm/pg-core'
import type { VectorMetaData } from '../types/rag.types.js'

// Custom vector type for pgvector
// Note: Default dimension should match your primary embedding model
// - 768 for Ollama nomic-embed-text or cl-nagoya/ruri models
// - 1536 for OpenAI text-embedding-3-small
// - 3072 for OpenAI text-embedding-3-large
const vector = customType<{
  data: number[]
  driverData: string
  config: { length: number }
}>({
  dataType(config) {
    return `vector(${config?.length ?? 768})`
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value)
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value)
  },
})

// Supported embedding dimensions for various models
// Note: pgvector supports up to 16000 dimensions, but we list commonly used sizes
export const supportedDimensionsForIndex = [
  128, 256, 384, 512, 768, 1024, 1280, 1536, 1792, 3072,
]

/**
 * Create an embeddings table Drizzle schema with a given table name.
 * Used for both the legacy shared table and per-workspace tables.
 */
export function createEmbeddingTable(tableName: string) {
  return pgTable(tableName, {
    id: serial('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    path: text('path').notNull(),
    mtime: bigint('mtime', { mode: 'number' }).notNull(),
    content: text('content').notNull(),
    model: text('model').notNull(),
    dimension: smallint('dimension').notNull(),
    embedding: vector('embedding', { length: 768 }).notNull(),
    metadata: jsonb('metadata').notNull().$type<VectorMetaData>(),
    configHash: text('config_hash'),
  })
}

// Legacy shared table — all workspaces that have not yet migrated use this
export const embeddingTable = createEmbeddingTable('embeddings')

export type SelectEmbedding = typeof embeddingTable.$inferSelect
export type InsertEmbedding = typeof embeddingTable.$inferInsert

// ── Per-workspace table helpers ───────────────────────────────────────────────

/** Physical table name for a workspace-specific embeddings table */
export function workspaceTableName(workspaceId: string): string {
  return `embeddings_ws_${workspaceId}`
}

/** HNSW index name for a workspace-specific table */
export function workspaceVectorIndexName(workspaceId: string): string {
  return `${workspaceTableName(workspaceId)}_embedding_idx`
}

/** SQL to create a workspace-specific embeddings table */
export function createWorkspaceTableSQL(workspaceId: string): string {
  const t = workspaceTableName(workspaceId)
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime BIGINT NOT NULL,
      content TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension SMALLINT NOT NULL,
      embedding vector(768) NOT NULL,
      metadata JSONB NOT NULL,
      config_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS ${t}_path_index ON ${t} (path);
    CREATE INDEX IF NOT EXISTS ${t}_model_index ON ${t} (model);
    CREATE INDEX IF NOT EXISTS ${t}_dimension_index ON ${t} (dimension);
  `
}

/** SQL to create the HNSW index on a workspace-specific table */
export function createWorkspaceVectorIndexSQL(workspaceId: string): string {
  const t = workspaceTableName(workspaceId)
  const idx = workspaceVectorIndexName(workspaceId)
  return `
    CREATE INDEX IF NOT EXISTS ${idx}
    ON ${t}
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `
}

/** SQL to drop the HNSW index on a workspace-specific table */
export function dropWorkspaceVectorIndexSQL(workspaceId: string): string {
  return `DROP INDEX IF EXISTS ${workspaceVectorIndexName(workspaceId)};`
}

// ── Legacy shared-table SQL (kept for backward compatibility) ─────────────────

// SQL for creating the shared embeddings table and indexes with pgvector
export const createEmbeddingsTableSQL = `
  -- Enable pgvector extension
  CREATE EXTENSION IF NOT EXISTS vector;

  -- Create embeddings table
  CREATE TABLE IF NOT EXISTS embeddings (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime BIGINT NOT NULL,
    content TEXT NOT NULL,
    model TEXT NOT NULL,
    dimension SMALLINT NOT NULL,
    embedding vector(768) NOT NULL,
    metadata JSONB NOT NULL,
    config_hash TEXT
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS embeddings_workspace_id_index ON embeddings (workspace_id);
  CREATE INDEX IF NOT EXISTS embeddings_path_index ON embeddings (path);
  CREATE INDEX IF NOT EXISTS embeddings_model_index ON embeddings (model);
  CREATE INDEX IF NOT EXISTS embeddings_dimension_index ON embeddings (dimension);
`

// SQL for creating vector similarity search index (HNSW for better performance)
export const createVectorIndexSQL = (dimension: number = 768) => `
  -- Create HNSW index for cosine similarity search
  -- Note: This should be created after data is inserted for better performance
  CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
  ON embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
`

// SQL for dropping vector similarity search index
export const dropVectorIndexSQL = `
  DROP INDEX IF EXISTS embeddings_embedding_idx;
`

// Alternative: IVFFlat index (faster to build, but requires training data)
export const createIVFFlatIndexSQL = (lists: number = 100) => `
  CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
  ON embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = ${lists});
`
