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

export const embeddingTable = pgTable(
  'embeddings',
  {
    id: serial('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(), // workspace identifier
    path: text('path').notNull(), // path to the file
    mtime: bigint('mtime', { mode: 'number' }).notNull(), // mtime of the file
    content: text('content').notNull(), // content of the chunk
    model: text('model').notNull(), // model id
    dimension: smallint('dimension').notNull(), // dimension of the vector
    embedding: vector('embedding', { length: 768 }).notNull(), // embedding vector (768 for Ollama/ruri, 1536 for OpenAI small, 3072 for OpenAI large)
    metadata: jsonb('metadata').notNull().$type<VectorMetaData>(),
  },
  (table) => [
    index('embeddings_workspace_id_index').on(table.workspaceId),
    index('embeddings_path_index').on(table.path),
    index('embeddings_model_index').on(table.model),
    index('embeddings_dimension_index').on(table.dimension),
  ],
)

export type SelectEmbedding = typeof embeddingTable.$inferSelect
export type InsertEmbedding = typeof embeddingTable.$inferInsert

// SQL for creating the embeddings table and indexes with pgvector
// Note: Adjust vector dimension to match your embedding model (768, 1536, or 3072)
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
    metadata JSONB NOT NULL
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

// Alternative: IVFFlat index (faster to build, but requires training data)
export const createIVFFlatIndexSQL = (lists: number = 100) => `
  CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
  ON embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = ${lists});
`
