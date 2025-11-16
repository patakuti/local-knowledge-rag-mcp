# Workspace ID Migration Guide

This guide explains how to migrate your existing database to support multiple workspaces.

## Overview

The `workspace_id` column enables the system to support multiple independent workspaces using the same PostgreSQL database. Each workspace is identified by a unique ID generated from its absolute path.

## Migration Steps

### Prerequisites

1. **Backup your database** before running any migration:
   ```bash
   pg_dump $DATABASE_URL > backup.sql
   ```

2. **Stop all running MCP servers** to prevent data inconsistency during migration.

### Option 1: Use MCP Tool (Recommended)

**This is the easiest method.** Use the built-in `reinitialize_schema` MCP tool to recreate the database schema with workspace support.

⚠️ **Warning**: This will delete all existing embeddings. You will need to rebuild your index.

1. **Use the MCP tool via Claude or your MCP client:**
   ```json
   {
     "tool": "reinitialize_schema",
     "arguments": { "confirm": true }
   }
   ```

2. **Rebuild your index:**
   ```json
   {
     "tool": "rebuild_index",
     "arguments": { "reindex_all": true }
   }
   ```

That's it! The schema will be recreated with the `workspace_id` column and all indexes.

### Option 2: Migrate Existing Data (Manual)

If you want to preserve your existing embeddings, follow these steps:

1. **Run the migration script:**
   ```bash
   psql $DATABASE_URL -f scripts/add-workspace-id.sql
   ```

2. **Update the default workspace ID:**

   The script uses `'default-workspace'` as a placeholder. You should update this to match your actual workspace:

   ```sql
   -- Calculate the workspace ID for your workspace path
   -- Example: If your workspace is /home/user/my-project

   -- First, generate the workspace ID using Node.js:
   node -e "
   const crypto = require('crypto');
   const path = require('path');
   const workspacePath = '/home/user/my-project';  // Update this!
   const normalizedPath = path.resolve(workspacePath).replace(/\\\\/g, '/');
   const workspaceId = crypto.createHash('sha256').update(normalizedPath).digest('hex').substring(0, 16);
   console.log('Workspace ID:', workspaceId);
   "

   -- Then, update the embeddings table:
   UPDATE embeddings
   SET workspace_id = 'YOUR_CALCULATED_WORKSPACE_ID'
   WHERE workspace_id = 'default-workspace';
   ```

3. **Verify the migration:**
   ```sql
   -- Check workspace IDs
   SELECT workspace_id, COUNT(*) as count
   FROM embeddings
   GROUP BY workspace_id;
   ```

## How Workspace IDs Work

### Generation Algorithm

Workspace IDs are generated using the following algorithm:

```typescript
import crypto from 'crypto'
import path from 'path'

function generateWorkspaceId(workspacePath: string): string {
  // 1. Normalize to absolute path
  const normalizedPath = path.resolve(workspacePath)

  // 2. Replace backslashes with forward slashes (Windows compatibility)
  const canonicalPath = normalizedPath.replace(/\\/g, '/')

  // 3. Create SHA-256 hash
  const hash = crypto.createHash('sha256').update(canonicalPath).digest('hex')

  // 4. Take first 16 characters
  return hash.substring(0, 16)
}
```

### Examples

| Workspace Path | Workspace ID |
|----------------|--------------|
| `/home/user/project-a` | `a1b2c3d4e5f6a7b8` |
| `/home/user/project-b` | `f8e7d6c5b4a3f2e1` |
| `C:\\Users\\user\\project` | `1234567890abcdef` |

Note: The actual IDs will be different based on the hash algorithm.

### Properties

- **Deterministic**: Same workspace path always generates the same ID
- **Unique**: Different workspace paths generate different IDs (with very high probability)
- **Short**: 16 characters (128 bits of entropy from SHA-256)
- **Platform-independent**: Works consistently across Windows, macOS, and Linux

## Impact on Existing Queries

### Before Migration

All queries were workspace-agnostic:
```sql
SELECT * FROM embeddings WHERE model = 'text-embedding-3-small';
```

### After Migration

All queries now filter by workspace:
```sql
SELECT * FROM embeddings
WHERE workspace_id = 'a1b2c3d4e5f6a7b8'
AND model = 'text-embedding-3-small';
```

This change is **automatic** and handled by the `VectorRepository` class. No code changes are required in your application.

## Multiple Workspaces

### Same Database, Multiple Workspaces

You can now use the same PostgreSQL database for multiple workspaces:

```bash
# Workspace A
cd /path/to/workspace-a
export DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
npm run dev

# Workspace B (in another terminal)
cd /path/to/workspace-b
export DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
npm run dev
```

Each workspace will maintain its own independent index in the same database.

### Query Example

To see all workspaces in your database:

```sql
SELECT
  workspace_id,
  COUNT(DISTINCT path) as file_count,
  COUNT(*) as chunk_count,
  model
FROM embeddings
GROUP BY workspace_id, model
ORDER BY workspace_id, model;
```

## Rollback

If you need to rollback the migration:

```sql
-- Restore from backup
psql $DATABASE_URL < backup.sql
```

## Troubleshooting

### Issue: "column workspace_id does not exist"

**Cause**: Migration script wasn't run or failed.

**Solution**: Run the migration script again.

### Issue: "duplicate key value violates unique constraint"

**Cause**: Trying to insert data with duplicate workspace_id + path + model combination.

**Solution**: This should not happen with the new implementation. If it does, it indicates a bug. Please report it.

### Issue: Old data not accessible after migration

**Cause**: The default workspace ID doesn't match the actual workspace path.

**Solution**: Update the workspace_id for old data:

```sql
-- Find the correct workspace ID
-- Use the Node.js script from Option 1 above

-- Update old data
UPDATE embeddings
SET workspace_id = 'YOUR_CORRECT_WORKSPACE_ID'
WHERE workspace_id = 'default-workspace';
```

## Verification

After migration, verify that:

1. The `workspace_id` column exists and is NOT NULL
2. The `embeddings_workspace_id_index` exists
3. All rows have valid workspace IDs
4. Your application can successfully index and search files

```sql
-- 1. Check column
\d embeddings

-- 2. Check index
SELECT indexname FROM pg_indexes WHERE tablename = 'embeddings';

-- 3. Check for NULL values
SELECT COUNT(*) FROM embeddings WHERE workspace_id IS NULL;

-- 4. View workspace summary
SELECT workspace_id, COUNT(*) FROM embeddings GROUP BY workspace_id;
```

## Next Steps

After successful migration:

1. Test indexing: Create a new index for your workspace
2. Test searching: Verify that search results are correct
3. Test multiple workspaces: Create indexes in different workspaces
4. Monitor: Check that workspaces remain isolated from each other

## Support

If you encounter issues during migration, please:

1. Check the logs for error messages
2. Verify your database connection
3. Ensure you have sufficient database permissions
4. Review the migration script output
5. Report issues with detailed error messages
