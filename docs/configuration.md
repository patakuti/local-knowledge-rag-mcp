# Configuration Guide

Complete guide to configuring the Local Knowledge RAG MCP Server.

---

## Overview

All configuration is done through environment variables, typically stored in a `.env` file. This MCP server is configured entirely on the **server side** - MCP clients (like Claude Code) communicate via the MCP protocol and don't access these variables directly.

---

## Quick Start

1. Copy the example file:
```bash
cp .env.example .env
```

2. Edit `.env` with your settings

3. Restart the MCP server (or use `reload_config` tool for most settings)

---

## Required Configuration

### Database Connection

**`DATABASE_URL`** (Required)

PostgreSQL connection string.

**Format:**
```bash
DATABASE_URL=postgresql://user:password@host:port/database
```

**Example:**
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/local_knowledge_rag
```

---

## Embedding Provider Configuration

You must configure ONE of the following embedding providers.

### Option A: OpenAI

**`OPENAI_API_KEY`** (Required for OpenAI)

Your OpenAI API key.

```bash
OPENAI_API_KEY=sk-your-openai-api-key
```

**`EMBEDDING_MODEL`** (Optional)

Embedding model to use. Default: `text-embedding-3-small`

```bash
EMBEDDING_MODEL=text-embedding-3-large
```

**Available models:**
- `text-embedding-3-small` (1536 dimensions)
- `text-embedding-3-large` (3072 dimensions)
- `text-embedding-ada-002` (1536 dimensions, legacy)

---

### Option B: Ollama (Local)

**`OLLAMA_BASE_URL`** (Required for Ollama)

Ollama API endpoint URL.

```bash
OLLAMA_BASE_URL=http://localhost:11434/v1
```

**`EMBEDDING_MODEL`** (Required for Ollama)

Embedding model name.

```bash
EMBEDDING_MODEL=nomic-embed-text
```

**Available models:**
- `nomic-embed-text` (768 dimensions)
- Any other model installed in your local Ollama instance

---

### Option C: OpenAI-compatible APIs (LiteLLM, Azure OpenAI, etc.)

**`OPENAI_COMPATIBLE_API_KEY`** (Required)

API key for your OpenAI-compatible service.

```bash
OPENAI_COMPATIBLE_API_KEY=your-api-key
```

**`OPENAI_COMPATIBLE_BASE_URL`** (Optional)

Base URL for the API endpoint. Default: `http://localhost:4000/v1`

**Important:** The OpenAI SDK automatically appends `/embeddings` to this URL.

```bash
OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint.com/v1
```

**Examples:**
- `https://example.com/v1` → requests to `https://example.com/v1/embeddings`
- `https://example.com/api` → requests to `https://example.com/api/embeddings`

**`EMBEDDING_MODEL`** (Optional)

Model name. Default: `openai-compatible-text-embedding-3-small`

```bash
EMBEDDING_MODEL=cl-nagoya/ruri-v3-310m
```

---

## RAG Configuration (Optional)

All RAG settings have sensible defaults. Only configure these if you need to customize behavior.

### Chunking Settings

**`RAG_CHUNK_SIZE`**

Chunk size in characters. Default: `1000`

```bash
RAG_CHUNK_SIZE=1000
```

**`RAG_CHUNK_OVERLAP`**

Chunk overlap in characters. Default: `200`

```bash
RAG_CHUNK_OVERLAP=200
```

**`RAG_CHUNK_LANGUAGE`**

Chunking language. Default: `markdown`

```bash
RAG_CHUNK_LANGUAGE=markdown
```

**`RAG_EXCLUDE_CODE_LANGUAGES`**

Code languages to exclude from Markdown indexing (comma-separated, case-insensitive).

**Default:** Common programming languages (JavaScript, TypeScript, Python, etc.)

**Included by default:** PlantUML, Mermaid, YAML, JSON, etc.

```bash
RAG_EXCLUDE_CODE_LANGUAGES=javascript,js,jsx,typescript,ts,tsx,python,py,java,kotlin,scala,c,cpp,c++,cxx,cc,h,hpp,csharp,cs,ruby,rb,php,go,golang,rust,rs,swift,perl,lua,r,matlab,dot,graphviz
```

**To index all code blocks:**
```bash
RAG_EXCLUDE_CODE_LANGUAGES=
```

**To also exclude PlantUML and Mermaid:**
```bash
RAG_EXCLUDE_CODE_LANGUAGES=javascript,js,typescript,ts,python,py,plantuml,mermaid
```

---

### Search Settings

**`RAG_MIN_SIMILARITY`**

Minimum similarity threshold (0.0-1.0). Default: `0.7`

```bash
RAG_MIN_SIMILARITY=0.7
```

**`RAG_MAX_RESULTS`**

Maximum number of search results. Default: `10`

```bash
RAG_MAX_RESULTS=10
```

**`RAG_MAX_CHUNKS_PER_QUERY`**

Maximum chunks per query. Default: `5`

```bash
RAG_MAX_CHUNKS_PER_QUERY=5
```

---

### Indexing Settings

**`RAG_INCLUDE_PATTERNS`**

File patterns to include in indexing (comma-separated glob patterns). Default: `**/*.md,**/*.txt`

```bash
RAG_INCLUDE_PATTERNS="**/*.md,**/*.txt"
```

**Examples:**
```bash
# Documentation-focused
RAG_INCLUDE_PATTERNS="**/*.md,**/*.txt,**/*.rst"

# Code-focused
RAG_INCLUDE_PATTERNS="**/*.ts,**/*.js,**/*.py,**/*.java"
```

**`RAG_EXCLUDE_PATTERNS`**

File patterns to exclude from indexing (comma-separated glob patterns).

**Default:** `node_modules/**,.git/**,*.min.*,dist/**,build/**,.next/**,.cache/**,coverage/**,.nyc_output/**,**/*.log,**/logs/**,**/.DS_Store,**/Thumbs.db,reports/**`

```bash
RAG_EXCLUDE_PATTERNS="**/node_modules/**,**/.git/**,**/dist/**"
```

---

### Report Settings

**`RAG_REPORT_OUTPUT_DIR`**

Report output directory. Default: `rag-reports`

```bash
RAG_REPORT_OUTPUT_DIR=rag-reports
```

**Note:** This directory is automatically excluded from indexing.

**`RAG_MAX_QUOTE_LINES`**

Maximum lines in quotes. Default: `5`

```bash
RAG_MAX_QUOTE_LINES=5
```

**`RAG_REMOVE_BLANK_LINES`**

Remove blank lines in reports. Default: `true`

```bash
RAG_REMOVE_BLANK_LINES=true
```

**`RAG_DEFAULT_TEMPLATE`**

Default template name. Default: `basic`

**Available templates:**
- `basic` - Basic report format
- `paper` - Academic paper style with numbered citations
- `bullet_points` - Bullet points style

```bash
RAG_DEFAULT_TEMPLATE=basic
```

---

### Session Settings

**`RAG_MAX_SESSION_RESULTS`**

Maximum number of cached search sessions. Default: `10`

```bash
RAG_MAX_SESSION_RESULTS=10
```

---

### Debug Settings

**`RAG_DEBUG_LOG_ENABLED`**

Enable debug logging. Default: `false`

```bash
RAG_DEBUG_LOG_ENABLED=false
```

**`RAG_DEBUG_LOG_PATH`**

Debug log file path. Default: `/tmp/local-knowledge-rag-mcp/debug.log`

```bash
RAG_DEBUG_LOG_PATH=/tmp/local-knowledge-rag-mcp/debug.log
```

---

## Configuration Priority

Settings are loaded in this order (highest priority first):

1. **Environment variables** (.env file or shell exports)
2. **Default values** (hardcoded in the application)

---

## Applying Configuration Changes

After editing your `.env` file, you have two options:

### Option 1: Use reload_config Tool (Recommended)

Reloads configuration without restarting the MCP server:

```json
{
  "tool": "reload_config"
}
```

**What gets reloaded:**
- RAG engine settings
- Embedding provider settings
- Session manager settings

**What does NOT get reloaded:**
- Running Index Manager processes (use `stop_index_manager` and `open_index_manager` to restart)

### Option 2: Restart MCP Server

Fully restarts all components, including Index Managers.

---

## Multi-Workspace Configuration

Multiple workspaces can share the same `DATABASE_URL`. Each workspace is automatically isolated by its absolute path.

**Example:**

Workspace A:
```bash
# /project-a/.env
DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
OPENAI_API_KEY=sk-your-key
```

Workspace B:
```bash
# /project-b/.env
DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
OPENAI_API_KEY=sk-your-key
```

Both workspaces share the same database but maintain isolated indexes.

---

## Security Best Practices

### API Key Management

1. **Never commit API keys to version control**

Add to `.gitignore`:
```gitignore
.env
.env.local
```

2. **Use `.env.example` with dummy values**

```bash
# .env.example
DATABASE_URL=postgresql://user:password@localhost:5432/local_knowledge_rag
OPENAI_API_KEY=sk-your-api-key-here
```

3. **Rotate keys regularly**

4. **Use environment-specific keys** when possible

### Production Deployment

For production environments, inject environment variables securely:

- **CI/CD pipelines**: GitHub Actions Secrets, GitLab CI/CD Variables
- **Docker**: `docker run -e` or `docker-compose.yml`
- **systemd**: `Environment=` directive
- **Cloud platforms**: AWS Secrets Manager, GCP Secret Manager, Azure Key Vault

---

## Configuration Examples

### Example 1: Local Development with OpenAI

```bash
# .env
DATABASE_URL=postgresql://postgres:password@localhost:5432/local_knowledge_rag
OPENAI_API_KEY=sk-your-openai-api-key
EMBEDDING_MODEL=text-embedding-3-small

RAG_CHUNK_SIZE=1000
RAG_MIN_SIMILARITY=0.7
RAG_DEFAULT_TEMPLATE=basic
```

### Example 2: Local Development with Ollama (Offline)

```bash
# .env
DATABASE_URL=postgresql://postgres:password@localhost:5432/local_knowledge_rag
OLLAMA_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=nomic-embed-text

RAG_CHUNK_SIZE=1000
RAG_MIN_SIMILARITY=0.7
```

### Example 3: Production with LiteLLM

```bash
# .env
DATABASE_URL=postgresql://user:password@db.example.com:5432/rag_prod
OPENAI_COMPATIBLE_BASE_URL=http://localhost:4000/v1
OPENAI_COMPATIBLE_API_KEY=your-litellm-key
EMBEDDING_MODEL=cl-nagoya/ruri-v3-310m

RAG_CHUNK_SIZE=2000
RAG_MIN_SIMILARITY=0.75
RAG_MAX_RESULTS=20
RAG_DEFAULT_TEMPLATE=paper
```

### Example 4: Documentation-focused Project

```bash
# .env
DATABASE_URL=postgresql://postgres:password@localhost:5432/docs_rag
OPENAI_API_KEY=sk-your-key

RAG_INCLUDE_PATTERNS="**/*.md,**/*.rst,**/*.txt,**/*.adoc"
RAG_EXCLUDE_PATTERNS="**/node_modules/**,**/.git/**"
RAG_CHUNK_SIZE=1500
RAG_MAX_QUOTE_LINES=10
```

---

## Troubleshooting Configuration

### Environment Variables Not Loading

1. Check `.env` file exists in project root
2. Verify file name is `.env` (not `.env.example`)
3. Restart MCP server to reload environment variables

### DATABASE_URL Connection Error

```
Error: DATABASE_URL environment variable is required
```

Solution: Add `DATABASE_URL` to your `.env` file.

### No Embedding Provider Detected

```
No embedding provider API key found
```

Solution: Configure at least one embedding provider (OpenAI, Ollama, or OpenAI-compatible).

---

## See Also

- [MCP Tools Reference](mcp-tools.md) - Detailed MCP tool documentation
- [Template Guide](templates.md) - Creating custom report templates
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
