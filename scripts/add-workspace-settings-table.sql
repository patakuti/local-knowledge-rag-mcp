-- Migration: Add workspace_settings table
-- This migration adds support for workspace-specific embedding provider configuration

-- =============================================================================
-- CREATE workspace_settings TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  -- Embedding provider configuration
  embedding_provider TEXT,           -- 'openai' | 'ollama' | 'openai-compatible' | NULL
  embedding_model TEXT,               -- Model name (e.g., 'text-embedding-3-small')
  embedding_base_url TEXT,            -- Base URL (for Ollama, OpenAI-compatible APIs)
  embedding_api_key TEXT,             -- API key (stored in plain text)
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS workspace_settings_workspace_id_idx
  ON workspace_settings(workspace_id);

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE workspace_settings IS 'Workspace-specific embedding provider configuration';
COMMENT ON COLUMN workspace_settings.workspace_id IS 'Unique workspace identifier (SHA-256 hash of workspace path)';
COMMENT ON COLUMN workspace_settings.embedding_provider IS 'Embedding provider type: openai, ollama, or openai-compatible';
COMMENT ON COLUMN workspace_settings.embedding_model IS 'Embedding model name';
COMMENT ON COLUMN workspace_settings.embedding_base_url IS 'Base URL for Ollama or OpenAI-compatible APIs';
COMMENT ON COLUMN workspace_settings.embedding_api_key IS 'API key for the embedding provider (plain text)';

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Verify the table was created
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'workspace_settings'
ORDER BY ordinal_position;

-- Check if index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'workspace_settings'
AND indexname = 'workspace_settings_workspace_id_idx';

-- Show table comment
SELECT
  obj_description('workspace_settings'::regclass, 'pg_class') as table_comment;
