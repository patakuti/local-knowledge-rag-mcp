# MCP Tools Reference

This document provides detailed information about all MCP tools available in the Local Knowledge RAG MCP Server.

---

## search_knowledge

Perform semantic search across your indexed documents.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The search query text |
| `min_similarity` | number | No | Minimum similarity threshold (0.0-1.0). Default: 0.7 |
| `max_results` | number | No | Maximum number of results. Default: 10 |
| `scope` | object | No | Limit search to specific files or folders |
| `scope.files` | string[] | No | Array of file paths to search within |
| `scope.folders` | string[] | No | Array of folder paths to search within |

### Examples

**Simple search:**
```json
{
  "query": "React hooks and state management",
  "min_similarity": 0.7
}
```

**Search within specific directories:**
```json
{
  "query": "React hooks and state management",
  "scope": {
    "folders": ["/src/hooks", "docs"]
  }
}
```

**Search within specific files:**
```json
{
  "query": "configuration options",
  "scope": {
    "files": ["README.md", "docs/setup.md"]
  }
}
```

**Combine folders and files:**
```json
{
  "query": "API endpoints",
  "scope": {
    "folders": ["/src/api"],
    "files": ["config/routes.ts"]
  }
}
```

### Folder Path Formats

- **Subdirectory name**: `"hooks"` → matches `**/hooks/**` (any `hooks` directory at any level)
- **Root-relative path**: `"/src/hooks"` → matches `src/hooks/**` (from workspace root)
- **Glob pattern**: `"src/*/tests"` → flexible pattern matching

### Returns

Returns a session ID that you can use with `get_search_results` to retrieve detailed results.

---

## get_search_results

Retrieve detailed results from previous search sessions.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_ids` | string[] | Yes | Array of session IDs from previous searches |
| `limit` | number | No | Maximum number of results per session. Default: 5 |

### Example

```json
{
  "session_ids": ["search_abc123"],
  "limit": 5
}
```

### Returns

Detailed search results including:
- File paths and line numbers
- Matching content chunks
- Similarity scores
- File URIs for direct navigation

---

## list_search_results

List all cached search sessions.

### Parameters

None

### Example

```json
{}
```

### Returns

List of all active search sessions with their IDs and queries.

---

## get_template_schema

Get the schema definition for a specific report template.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `template` | string | No | Template name (e.g., "paper", "basic"). If omitted, returns schema for default template |

### Example

```json
{
  "template": "paper"
}
```

### Returns

JSON schema describing the required and optional variables for the template.

---

## create_rag_report

Generate a formatted Markdown report from search results.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `variables` | object | Yes | Template variables (see template schema) |
| `template` | string | No | Template name. If omitted, uses workspace default |
| `output_dir` | string | No | Output directory. If omitted, uses `RAG_REPORT_OUTPUT_DIR` from .env |

### Example

```json
{
  "template": "basic",
  "variables": {
    "query": "React Hooks Analysis",
    "generated_at": "2025-11-12 14:30:00",
    "overall_summary": "Summary of findings...",
    "sections": [
      {
        "file_name_with_line": "example.ts:10-20",
        "file_uri": "file:///path/to/example.ts#L10",
        "section_summary": "This section shows...",
        "section_quote": "code snippet here..."
      }
    ]
  }
}
```

### Returns

Path to the generated report file.

---

## rebuild_index

Rebuild the document index.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reindex_all` | boolean | No | If true, rebuild entire index. If false, update only new/modified files. Default: false |

### Examples

**Update index (incremental):**
```json
{
  "reindex_all": false
}
```

**Rebuild entire index:**
```json
{
  "reindex_all": true
}
```

### Returns

Progress information and final statistics when complete.

---

## cancel_index_generation

Cancel the currently running index generation or rebuild operation.

### Parameters

None

### Example

```json
{}
```

### Returns

Confirmation message when cancellation is complete.

---

## index_status

Check the current status of the index.

### Parameters

None

### Example

```json
{}
```

### Returns

Index statistics including:
- Total indexed files
- Total chunks
- Index status (up to date, needs update, etc.)
- Last update timestamp

---

## reinitialize_schema

⚠️ **DESTRUCTIVE OPERATION** ⚠️

Delete all embeddings for THIS WORKSPACE only. Other workspaces are not affected.

**When to use:**
- Error recovery
- Database cleanup
- NOT for switching embedding models (use `reload_config` + `rebuild_index` instead)

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confirm` | boolean | Yes | Must be `true` to confirm the destructive operation |

### Example

```json
{
  "confirm": true
}
```

### Returns

Confirmation message when schema has been reinitialized.

---

## reload_config

Reload configuration from .env file without restarting the MCP server.

### Parameters

None

### Example

```json
{}
```

### What gets reloaded:
- RAG engine settings (chunk size, similarity threshold, etc.)
- Embedding provider settings
- Session manager settings

### What does NOT get reloaded:
- Running Index Manager processes (use `stop_index_manager` and `open_index_manager` to restart)

### Returns

Confirmation message and summary of loaded configuration.

---

## open_index_manager

Open the Index Manager in your browser.

### Parameters

None

### Example

```json
{}
```

### Returns

URL where the Index Manager is accessible.

---

## list_index_managers

List all running Index Manager processes.

### Parameters

None

### Example

```json
{}
```

### Returns

List of running Index Manager processes with their PIDs and ports.

---

## stop_index_manager

Stop a specific Index Manager process.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pid` | number | No | Process ID to stop. If omitted, stops the Index Manager for current workspace |

### Example

```json
{
  "pid": 12345
}
```

Or simply:

```json
{}
```

### Returns

Confirmation message when the process has been stopped.

---

## Workflow Examples

### Complete Search and Report Workflow

1. **Check existing searches:**
```json
{
  "tool": "list_search_results"
}
```

2. **Perform a search:**
```json
{
  "tool": "search_knowledge",
  "arguments": {
    "query": "React hooks and state management",
    "min_similarity": 0.7
  }
}
```

3. **Get detailed results:**
```json
{
  "tool": "get_search_results",
  "arguments": {
    "session_ids": ["search_abc123"],
    "limit": 5
  }
}
```

4. **Get template schema:**
```json
{
  "tool": "get_template_schema",
  "arguments": {
    "template": "paper"
  }
}
```

5. **Generate report:**
```json
{
  "tool": "create_rag_report",
  "arguments": {
    "template": "paper",
    "variables": {
      "query": "React Hooks Analysis",
      "generated_at": "2025-11-16 14:30:00",
      "overall_summary": "Analysis of React hooks usage patterns...",
      "sections": [...]
    }
  }
}
```

### Switching Embedding Models

1. **Edit .env file** with new model settings

2. **Reload configuration:**
```json
{
  "tool": "reload_config"
}
```

3. **Rebuild index:**
```json
{
  "tool": "rebuild_index",
  "arguments": {
    "reindex_all": true
  }
}
```

### Error Recovery

If you encounter database errors or corrupted index:

1. **Reinitialize schema:**
```json
{
  "tool": "reinitialize_schema",
  "arguments": {
    "confirm": true
  }
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

---

## See Also

- [Configuration Guide](configuration.md) - Detailed configuration options
- [Template Guide](templates.md) - Creating custom report templates
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
