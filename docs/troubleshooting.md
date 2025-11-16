# Troubleshooting Guide

Complete guide to troubleshooting common issues with Local Knowledge RAG MCP Server.

---

## General Debugging

### Check Logs First

**Index Manager Logs:**
```bash
tail -f /tmp/local-knowledge-rag-mcp/{workspaceId}/index-manager.log
```

**Progress Logs:**
```bash
tail -f /tmp/local-knowledge-rag-mcp/{workspaceId}/progress/*.log
```

**Enable Debug Logging:**

Add to `.env`:
```bash
RAG_DEBUG_LOG_ENABLED=true
RAG_DEBUG_LOG_PATH=/tmp/local-knowledge-rag-mcp/debug.log
```

Then restart MCP server.

---

## Installation & Setup Issues

### PostgreSQL Connection Errors

**Problem:** Cannot connect to PostgreSQL

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solutions:**

1. **Check PostgreSQL is running:**
```bash
# Ubuntu/Debian
sudo systemctl status postgresql

# Docker
docker ps | grep pgvector
```

2. **Verify DATABASE_URL:**
```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"
```

3. **Check PostgreSQL is listening:**
```bash
# Check listening ports
sudo netstat -tlnp | grep 5432
```

4. **Verify user permissions:**
```bash
psql $DATABASE_URL -c "\du"
```

### pgvector Extension Not Available

**Problem:**
```
ERROR: extension "vector" is not available
```

**Solutions:**

1. **Install pgvector:**
```bash
# Ubuntu/Debian
sudo apt-get install postgresql-16-pgvector

# Or use Docker with pgvector pre-installed
docker run -d -p 5432:5432 ankane/pgvector
```

2. **Verify installation:**
```sql
SELECT * FROM pg_available_extensions WHERE name = 'vector';
```

### Node.js Version Issues

**Problem:**
```
Error: Node.js version 18 or higher is required
```

**Solution:**

Install Node.js 18 or later:
```bash
# Using nvm
nvm install 18
nvm use 18

# Or download from nodejs.org
```

---

## Indexing Issues

### Documents Not Being Indexed

**Problem:** Files don't appear in the index

**Most common cause:** Configuration errors

**Step-by-step debugging:**

1. **Check logs:**
```bash
tail -f /tmp/local-knowledge-rag-mcp/{workspaceId}/index-manager.log
```

2. **Verify .env configuration:**
```bash
cat .env | grep -E "DATABASE_URL|OPENAI|OLLAMA|EMBEDDING"
```

3. **Check file patterns:**

Open Index Manager and check "Current Configuration" section.

Verify `RAG_INCLUDE_PATTERNS` matches your files:
```bash
# Test pattern matching
ls **/*.md
```

4. **Check file permissions:**
```bash
# Ensure files are readable
ls -la path/to/your/files
```

5. **Test with minimal config:**

Create `.env.test`:
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/test_db
OPENAI_API_KEY=sk-your-key
RAG_INCLUDE_PATTERNS="**/*.md"
RAG_EXCLUDE_PATTERNS="**/node_modules/**"
```

### Index Status Shows "Needs Update" After Indexing

**Problem:** Status doesn't change to "Up to Date" after indexing completes

**Possible causes:**

1. **Files were added/modified during indexing**
   - Solution: Run "Update Index" again

2. **File pattern mismatch**
   - Solution: Check `RAG_INCLUDE_PATTERNS` and `RAG_EXCLUDE_PATTERNS`

3. **Permission issues**
   - Solution: Check file permissions

### Indexing Stuck or Very Slow

**Problem:** Indexing progress bar doesn't move

**Solutions:**

1. **Check API rate limits:**

Look for rate limit errors in logs:
```bash
grep "rate limit" /tmp/local-knowledge-rag-mcp/*/index-manager.log
```

2. **Reduce chunk size temporarily:**
```bash
# .env
RAG_CHUNK_SIZE=500
```

3. **Use local Ollama instead:**
```bash
# .env
OLLAMA_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

4. **Check network connectivity:**
```bash
# Test OpenAI connectivity
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

---

## Search Issues

### No Search Results Returned

**Problem:** Search queries return no results

**Solutions:**

1. **Verify index exists:**
```json
{
  "tool": "index_status"
}
```

2. **Lower similarity threshold:**
```json
{
  "tool": "search_knowledge",
  "arguments": {
    "query": "your query",
    "min_similarity": 0.5
  }
}
```

3. **Try different search terms:**
   - More general terms
   - Different keywords
   - Synonyms

4. **Check indexed content:**

Use Index Manager to verify files are indexed.

### Search Returns Irrelevant Results

**Problem:** Search results don't match query intent

**Solutions:**

1. **Increase similarity threshold:**
```bash
# .env
RAG_MIN_SIMILARITY=0.8
```

2. **Use more specific queries:**
   - Include technical terms
   - Add context
   - Specify file types or directories

3. **Rebuild index with better chunking:**
```bash
# .env
RAG_CHUNK_SIZE=1500
RAG_CHUNK_OVERLAP=300
```

---

## Embedding Provider Issues

### OpenAI API Errors

**Problem:** Invalid API key or rate limit errors

**Solutions:**

1. **Verify API key:**
```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

2. **Check API key permissions:**
   - Ensure key has embedding permissions
   - Check organization/project settings

3. **Handle rate limits:**
   - Wait and retry
   - Upgrade to higher tier
   - Use Ollama for offline processing

4. **Check quota:**

Visit https://platform.openai.com/usage

### Ollama Connection Errors

**Problem:** Cannot connect to Ollama

```
Error: connect ECONNREFUSED 127.0.0.1:11434
```

**Solutions:**

1. **Verify Ollama is running:**
```bash
ps aux | grep ollama
```

2. **Check Ollama endpoint:**
```bash
curl http://localhost:11434/v1/models
```

3. **Verify model is installed:**
```bash
ollama list
```

4. **Pull model if needed:**
```bash
ollama pull nomic-embed-text
```

### LiteLLM Connection Issues

**Problem:** Cannot connect to LiteLLM server

**Solutions:**

1. **Verify LiteLLM is running:**
```bash
curl http://localhost:4000/health
```

2. **Check configuration:**
```bash
cat litellm-config.yaml
```

3. **Test embedding endpoint:**
```bash
curl http://localhost:4000/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_COMPATIBLE_API_KEY" \
  -d '{"input": "test", "model": "cl-nagoya/ruri-v3-310m"}'
```

---

## Dimension Mismatch Errors

**Problem:**
```
Error: Dimension mismatch: expected 768 but got 1536
```

**Cause:** Changing embedding model with different dimensions

**Solution:**

The system should handle this automatically. If you see this error:

1. **Reload config:**
```json
{
  "tool": "reload_config"
}
```

2. **Rebuild index:**
```json
{
  "tool": "rebuild_index",
  "arguments": {
    "reindex_all": true
  }
}
```

3. **If still failing, reinitialize:**
```json
{
  "tool": "reinitialize_schema",
  "arguments": {
    "confirm": true
  }
}
```

Then rebuild index.

---

## Index Manager Issues

### Index Manager Won't Open

**Problem:** Browser doesn't open or shows connection error

**Solutions:**

1. **Check server logs:**

Look for "Console available at:" message in MCP server output.

2. **Find the actual port:**
```bash
lsof -i | grep node
```

3. **Try direct URL:**

If port is 3456:
```
http://localhost:3456
```

4. **Check firewall:**
```bash
# Ubuntu/Debian
sudo ufw status
```

### Index Manager Shows Stale Data

**Problem:** UI doesn't update after indexing

**Solutions:**

1. **Refresh browser** (F5 or Cmd+R)

2. **Restart Index Manager:**
```json
{
  "tool": "stop_index_manager"
}
```

Then:
```json
{
  "tool": "open_index_manager"
}
```

### Multiple Index Managers Running

**Problem:** Multiple Index Manager processes running

**Solutions:**

1. **List all Index Managers:**
```json
{
  "tool": "list_index_managers"
}
```

2. **Stop extra processes:**
```json
{
  "tool": "stop_index_manager",
  "arguments": {
    "pid": 12345
  }
}
```

---

## Report Generation Issues

### Template Not Found

**Problem:**
```
Error: Template 'custom' not found
```

**Solutions:**

1. **Check template file exists:**
```bash
ls -la templates/custom.md
```

2. **Use available template:**
   - `basic`
   - `paper`
   - `bullet_points`

3. **Create custom template:**

See [Template Guide](templates.md)

### Report Variables Missing

**Problem:**
```
Error: Required variable 'sections' is missing
```

**Solution:**

Get template schema first:
```json
{
  "tool": "get_template_schema",
  "arguments": {
    "template": "basic"
  }
}
```

Then provide all required variables.

---

## Performance Issues

### Slow Search Performance

**Solutions:**

1. **Use more specific include patterns:**
```bash
# .env
RAG_INCLUDE_PATTERNS="docs/**/*.md,src/**/*.ts"
```

2. **Increase chunk size:**
```bash
# .env
RAG_CHUNK_SIZE=2000
```

3. **Use HNSW indexing:**

Already enabled by default with pgvector.

4. **Optimize PostgreSQL:**
```sql
VACUUM ANALYZE embeddings;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_embeddings_workspace
  ON embeddings(workspace_id);
```

### High Memory Usage

**Solutions:**

1. **Reduce max session results:**
```bash
# .env
RAG_MAX_SESSION_RESULTS=5
```

2. **Reduce max results:**
```bash
# .env
RAG_MAX_RESULTS=5
```

3. **Use incremental updates:**

Instead of full rebuilds, use "Update Index" button.

---

## Concurrent Operation Issues

### "Index Operation Already in Progress"

**Problem:** Cannot start indexing while another operation is running

**This is by design** to prevent:
- Resource exhaustion
- Data corruption
- Race conditions

**Solutions:**

1. **Wait for current operation:**

Check Index Manager UI for progress.

2. **Cancel current operation:**
```json
{
  "tool": "cancel_index_generation"
}
```

Wait for cancellation to complete, then start new operation.

---

## Database Issues

### Database Connection Pool Exhausted

**Problem:**
```
Error: Connection pool exhausted
```

**Solutions:**

1. **Check for connection leaks:**

Review logs for unclosed connections.

2. **Restart MCP server**

3. **Increase pool size:**

(Not currently configurable - contact maintainers if this is a recurring issue)

### Database Migration Errors

**Problem:** Schema initialization fails

**Solution:**

1. **Backup database first**

2. **Drop and recreate:**
```sql
DROP DATABASE IF EXISTS local_knowledge_rag;
CREATE DATABASE local_knowledge_rag;
```

3. **Reinitialize:**
```json
{
  "tool": "reinitialize_schema",
  "arguments": {
    "confirm": true
  }
}
```

---

## See Also

- [Configuration Guide](configuration.md) - Detailed configuration options
- [MCP Tools Reference](mcp-tools.md) - Detailed MCP tool documentation
- [Template Guide](templates.md) - Creating custom report templates
