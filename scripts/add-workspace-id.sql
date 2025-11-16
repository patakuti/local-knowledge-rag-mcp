-- Migration: Add workspace_id column to embeddings table
-- This migration adds support for multiple workspaces by adding a workspace_id column
-- and updating indexes accordingly.

-- IMPORTANT: This migration requires manual intervention
-- Before running this script:
-- 1. Backup your database
-- 2. Decide how to handle existing data (see options below)

-- =============================================================================
-- MIGRATION OPTIONS
-- =============================================================================

-- Option 1: Add workspace_id with a default value for existing data
-- This assumes all existing data belongs to a single workspace
-- Replace 'default-workspace' with an appropriate value for your use case

-- Step 1: Add workspace_id column (allowing NULL temporarily)
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Step 2: Set a default workspace_id for existing rows
-- You may want to calculate this based on your workspace path
-- Example: If your workspace is at /home/user/my-project, you might use:
-- SELECT md5('/home/user/my-project')::text as workspace_id
UPDATE embeddings
SET workspace_id = 'default-workspace'
WHERE workspace_id IS NULL;

-- Step 3: Make workspace_id NOT NULL
ALTER TABLE embeddings ALTER COLUMN workspace_id SET NOT NULL;

-- Step 4: Create index on workspace_id
CREATE INDEX IF NOT EXISTS embeddings_workspace_id_index ON embeddings (workspace_id);

-- Step 5: Reorder columns for better organization (optional)
-- Note: PostgreSQL doesn't support reordering columns directly
-- If you want workspace_id as the second column, you would need to:
-- 1. Create a new table with the desired column order
-- 2. Copy data from the old table
-- 3. Drop the old table
-- 4. Rename the new table
-- This is optional and not recommended unless you have specific requirements

-- =============================================================================
-- ALTERNATIVE: Option 2 - Fresh Start (drops all existing data)
-- =============================================================================
-- Uncomment the following if you want to start fresh with a new schema:

-- DROP TABLE IF EXISTS embeddings CASCADE;
-- CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE TABLE embeddings (
--   id SERIAL PRIMARY KEY,
--   workspace_id TEXT NOT NULL,
--   path TEXT NOT NULL,
--   mtime BIGINT NOT NULL,
--   content TEXT NOT NULL,
--   model TEXT NOT NULL,
--   dimension SMALLINT NOT NULL,
--   embedding vector(768) NOT NULL,  -- Adjust dimension as needed (768, 1536, or 3072)
--   metadata JSONB NOT NULL
-- );
-- CREATE INDEX embeddings_workspace_id_index ON embeddings (workspace_id);
-- CREATE INDEX embeddings_path_index ON embeddings (path);
-- CREATE INDEX embeddings_model_index ON embeddings (model);
-- CREATE INDEX embeddings_dimension_index ON embeddings (dimension);

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Verify the migration
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'embeddings'
ORDER BY ordinal_position;

-- Check if workspace_id index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'embeddings'
AND indexname = 'embeddings_workspace_id_index';

-- Count rows per workspace
SELECT workspace_id, COUNT(*) as row_count
FROM embeddings
GROUP BY workspace_id;
