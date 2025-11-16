-- Migration script to convert existing database to use pgvector
-- This script should be run manually on existing databases

-- Step 1: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Check if migration is needed
DO $$
BEGIN
  -- Check if embedding column is already vector type
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'embeddings'
    AND column_name = 'embedding'
    AND data_type = 'jsonb'
  ) THEN
    RAISE NOTICE 'Starting migration from JSONB to vector type...';

    -- Step 3: Add new vector column
    -- Using vector(3072) to support all embedding models (768, 1536, 3072 dimensions)
    ALTER TABLE embeddings ADD COLUMN embedding_vector vector(3072);

    -- Step 4: Convert JSONB to vector
    -- Note: If you have embeddings with different dimensions, adjust the vector size accordingly
    UPDATE embeddings
    SET embedding_vector = (embedding::text)::vector(3072);

    -- Step 5: Drop old JSONB column and rename new column
    ALTER TABLE embeddings DROP COLUMN embedding;
    ALTER TABLE embeddings RENAME COLUMN embedding_vector TO embedding;

    -- Step 6: Add NOT NULL constraint
    ALTER TABLE embeddings ALTER COLUMN embedding SET NOT NULL;

    RAISE NOTICE 'Migration completed successfully!';
  ELSE
    RAISE NOTICE 'Database is already using vector type. No migration needed.';
  END IF;
END $$;

-- Step 7: Create HNSW index for better performance
-- Note: This may take several minutes depending on data size
CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
ON embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Verify the migration
SELECT
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_name = 'embeddings'
AND column_name = 'embedding';
