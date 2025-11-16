# Local Knowledge RAG MCP Server - Architecture Design

## Architecture Overview

- Provides RAG (Retrieval Augmented Generation) functionality as an MCP server
- Extracted and adapted from Obsidian Smart Composer's RAG functionality
- Integrates with Claude Code
- Communicates via stdio using the MCP protocol

## Core Components

### 1. MCP Server Layer (src/mcp-server.ts)

- **LocalKnowledgeRAGServer class**
  - MCP server implementation
  - Provides 13 tools (search_knowledge, get_search_results, create_rag_report, generate_report, list_search_results, rebuild_index, cancel_index_generation, index_status, reinitialize_schema (workspace-scoped), reload_config, open_index_manager, list_index_managers, stop_index_manager)
  - Integrates RAGEngine, SessionManager, TemplateEngine, ProgressServer
  - Starts Index Manager web server on initialization (if not disabled)
  - Manages index cancellation via CancellationController

### 2. RAG Engine Layer (src/core/)

#### RAGEngine (rag-engine.ts)

- **Key Features**
  - Executes vector search
  - Initializes and updates indexes
  - Manages configuration
  - Automatic incremental updates
- **Key Methods**
  - `initialize()`: Initialize the engine
  - `searchWithAutoUpdate()`: Execute search with auto-update
  - `updateVaultIndex()`: Update index
  - `getIndexStatus()`: Get index status

#### VectorManager (vector-manager.ts)

- **Key Features**
  - File scanning and chunking
  - Vector embedding generation
  - Integration with PostgreSQL database
  - Incremental update management
  - HNSW index creation and management
  - Real-time progress tracking with ProgressLogger (throttled to 500ms intervals)
  - **Concurrent update protection**: Uses VectorRepository's advisory locks to ensure safe multi-server updates
- **Database**
  - Uses PostgreSQL with pgvector extension
  - Connection via DATABASE_URL environment variable
  - Vector similarity search using pgvector's <=> operator (cosine distance)
  - HNSW indexing for fast approximate nearest neighbor search
  - **Schema vector dimension must exactly match the embedding model dimension**
  - Default schema uses vector(768) for Ollama/ruri models
  - Dimension column tracks actual embedding size per row for consistency checks

#### VectorRepository (vector-repository.ts)

- **Key Features**
  - Abstraction of database operations
  - Vector CRUD operations
  - Automatic detection of embedding column type (vector vs JSONB)
  - **pgvector mode**: Fast similarity search using native <=> operator (when embedding column is vector type)
  - **JSONB fallback mode**: JavaScript-based cosine similarity calculation (for backward compatibility with JSONB embeddings)
  - Seamless migration path: automatically uses optimal method based on schema
  - Efficient vector distance calculations in PostgreSQL
  - **PostgreSQL advisory locks**: Prevent concurrent updates across multiple server processes
    - `acquireAdvisoryLock()`: Acquire exclusive lock for workspace
    - `releaseAdvisoryLock()`: Release lock
    - `withAdvisoryLock()`: Execute function within lock (automatic acquire/release)

#### EmbeddingClient (embedding-client.ts)

- **Supported Providers**
  - OpenAI (text-embedding-3-small, text-embedding-3-large)
  - Ollama (local execution)
  - OpenAI-compatible APIs (Azure OpenAI, local LLMs, etc.)
- **Key Features**
  - Generates embedding vectors
  - Rate limiting and retry handling
  - Abstraction across providers
  - Automatic dimension detection and configuration
- **Embedding Dimensions**
  - text-embedding-3-small: 1536 dimensions
  - text-embedding-3-large: 3072 dimensions
  - nomic-embed-text (Ollama): 768 dimensions
  - cl-nagoya/ruri models: 768 dimensions
  - **Database vector column must match the model dimension exactly**
  - Each embedding record stores its dimension for validation and consistency

#### SessionManager (session-manager.ts)

- **Key Features**
  - Manages search sessions
  - Caches search results (LRU-based)
  - Integrates multiple sessions
- **Implementation Details**
  - Manages sessions with `Map<string, SessionSearchResult>`
  - Session ID: `search_` + UUID (8 characters)
  - Default max retention: 10 sessions

#### TemplateEngine (template-engine.ts)

- **Key Features**
  - Generates Markdown reports
  - Loads and processes templates
  - Generates file URIs and line numbers
- **Template Variables**
  - `{{query}}`, `{{generated_at}}`, `{{overall_summary}}`
  - `{{#sections}}...{{/sections}}`: Section loop
  - `{{file_name}}`, `{{file_name_with_line}}`, `{{file_uri}}`
  - `{{section_summary}}`, `{{section_quote}}`
- **Output**
  - Default output directory: `./rag-reports/`
  - Filename format: `YYYYMMDD_HHMMSS_<query>.md`

### 3. Utility Layer (src/utils/)

#### file-utils.ts

- File system operations
- File pattern matching (glob, minimatch)
- File information retrieval

#### chunk-utils.ts

- Text chunking
- Uses LangChain's RecursiveCharacterTextSplitter
- Default settings: 1000-character chunks with 200-character overlap

#### response-formatter.ts

- MCP response formatting
- Error message generation

#### progress-logger.ts

- Writes progress updates to system temporary directory (`/tmp/local-knowledge-rag-mcp/{workspaceId}/progress.log`)
- JSON Lines format for easy parsing
- Logs start, progress, completion, and error events
- Includes timestamps and detailed progress data

#### progress-server.ts

- Simple HTTP server for Index Manager visualization
- **Runs as an independent process** (`index-manager.ts`), decoupled from MCP server lifecycle
- Continues running even when MCP server processes are terminated
- Logs to `/tmp/local-knowledge-rag-mcp/{workspaceId}/index-manager.log`
- **Dynamic Port Detection**: Automatically finds available port starting from preferred port (default: 3456)
- Serves **Index Manager** HTML page with real-time updates
- API endpoints:
  - `/progress` (GET) returns JSON array of log entries
  - `/schema-status` (GET) returns schema validation status and project statistics
    - Workspace path (project directory)
    - Schema dimension, embedding dimension, validation status
    - Project statistics: totalFilesInProject, indexedFiles, notIndexedFiles, deletedFiles
      - Note: Empty files (size = 0) are excluded from statistics to match indexing behavior
  - `/rebuild-index` (POST) rebuilds or updates index based on `reindex_all` parameter
    - Accepts JSON body: `{ "reindex_all": true/false }`
    - `reindex_all: false` performs incremental update
    - `reindex_all: true` performs full rebuild
  - `/cancel-indexing` (POST) requests cancellation of ongoing indexing operation
- Polls log file and updates UI every second
- Index Manager displays:
  - **Project Statistics Section**: Overall project file statistics (Total Files, Indexed Files, Not Indexed, Deleted Files)
  - **Indexing Status & Operations Section**: Combined section with status, progress, and control buttons
    - Index status: No Index / Needs Update / Up to Date / Updating / Cancelling
      - After indexing completes, status is automatically re-checked to detect any file additions/deletions
      - Shows "Needs Update" if files changed during indexing, "Up to Date" otherwise
    - Visual progress bar with percentage
    - Chunks and Files shown as "Indexed / Total" format (current update progress only)
    - Current file being processed (shown during indexing)
    - Update Index button (incremental update)
    - Rebuild Index button (full rebuild)
    - Cancel button (shown during active indexing)
  - **Current Configuration Section**: Collapsible information panel
    - Shows instructions for applying configuration changes
    - All settings are configured via environment variables (.env file)
    - To apply changes: Edit .env, then use `reload_config` MCP tool or restart MCP server
    - To apply changes to Index Manager: Use `stop_index_manager` and `open_index_manager` tools
  - **Activity Log Section**: Last 3 entries with timestamps
- Handles rate limit notifications
- `getPort()` method returns actual port being used

#### browser-flag.ts

- File-based flag to track which Index Manager ports have opened browsers
- Stores flag file in system temp directory (workspace-specific)
- Tracks both PID and port for each server instance
- Each unique port opens its browser once (enables multiple Claude Code instances)
- Methods: `hasOpened(port?)`, `markOpened(port)`, `clear()`
- Automatically cleans up entries for dead processes

#### progress-server-flag.ts

- File-based flag to coordinate Index Manager server startup across multiple MCP server processes
- Ensures only one Index Manager server runs per workspace, even when multiple processes are active
- Stores flag file in system temp directory (workspace-specific)
- Tracks the PID and port of the process that owns the ProgressServer
- Methods: `getRunningServer()`, `tryRegister(port)`, `unregister()`
- Automatically cleans up entries for dead processes
- Prevents duplicate consoles when Claude Code extension spawns multiple MCP server processes

### 4. Type Definitions (src/types/rag.types.ts)

- **Core Types**
  - `EmbeddingModelClient`: Embedding model interface
  - `SearchResult`: Search results
  - `SessionSearchResult`: Session-based search results
- **Configuration Types**
  - `RAGConfig`: Overall configuration
  - `EmbeddingModelConfig`, `ChunkingConfig`, `SearchConfig`, `IndexingConfig`, `ReportConfig`
- **Progress Tracking Types**
  - `IndexProgress`: Progress information for index updates
    - `completedChunks`: Number of chunks processed
    - `totalChunks`: Total chunks to process
    - `totalFiles`: Total files to process
    - `currentFileName`: Name of file currently being processed (optional)
    - `completedFiles`: Number of files completed (optional)
    - `waitingForRateLimit`: Whether waiting for API rate limit (optional)
  - `QueryProgressState`: Union type for different progress states
- **Error Types**
  - `RAGError`, `EmbeddingError`, `IndexingError`, `SearchError`

## Data Flow

### Search Flow

1. `search_knowledge` tool is called
2. RAGEngine converts search query to embedding vector
3. VectorRepository executes cosine similarity search
4. Results are stored in SessionManager
5. Returns session ID and preview of top 5 results

### Report Generation Flow (create_rag_report)

1. `create_rag_report` tool is called
2. SessionManager retrieves results from multiple sessions
3. Uses summary and section information provided by Claude Code
4. TemplateEngine processes the template
5. Generates and saves Markdown file
6. Returns file path and content preview

### Index Update Flow

1. `rebuild_index` or automatic update is triggered
2. CancellationController is reset at the start of indexing
3. ProgressLogger initializes and clears previous log file
4. ProgressServer starts HTTP server on configured port (default: 3456)
5. VectorManager scans the workspace
6. Chunks modified files
7. EmbeddingClient generates embedding vectors with real-time progress tracking:
   - Progress updates sent every 500ms (throttled)
   - Tracks chunk completion, file completion, and current file
   - Shows percentage completion
   - Logs progress to system temporary directory in JSON Lines format
   - Progress viewer polls log file every second and updates UI
   - Shows "Cancel Indexing" button during active indexing
   - Handles rate limit notifications
   - **Cancellation support**: Checks cancellation flag before each batch
8. VectorRepository saves to database in batches
9. Returns detailed progress information with statistics
10. ProgressLogger writes completion, error, or cancelled status

### Index Cancellation

- `cancel_index_generation` tool or Cancel button in Progress Viewer can stop indexing
- Cancellation is checked at multiple checkpoints for fast response:
  - Before each batch (every 10 chunks)
  - At the start of each chunk processing
  - Before each embedding API call
  - After each batch completes
- When cancelled:
  - Processing stops quickly (within current batch of max 10 chunks)
  - Partial data remains in the database
  - Status shows "cancelled" with progress completed
  - User can run `rebuild_index` again to resume
- CancellationController maintains cancellation state across components

## Configuration Management

### Configuration Priority

All configuration settings (embedding provider and RAG behavior) are managed via environment variables:

1. **Environment variables** (.env file or shell exports) - Primary configuration method
2. **Default values** - Built-in defaults used when environment variables are not set

### Applying Configuration Changes

After editing the `.env` file, you have two options:

1. **Use `reload_config` MCP tool** (Recommended):
   - Reloads .env file and reinitializes RAG engine without restarting MCP server
   - Updates embedding settings, RAG configuration, and session manager
   - Running Index Managers are not affected (use `stop_index_manager` and `open_index_manager` to restart them)

2. **Restart MCP server**:
   - Fully restarts all components
   - Index Managers will also need to be restarted

**Effect of Changes:**
- **Embedding changes** (provider, model): Require index rebuild if dimensions change
- **RAG chunking/pattern changes**: Require index rebuild for changes to take effect
- **RAG search/report changes**: Applied immediately after reload

**Implementation:**
- `src/core/embedding-config-loader.ts`: Loads embedding configuration from environment variables
- `src/core/rag-config-loader.ts`: Loads RAG configuration from environment variables
- `src/mcp-server.ts`: `handleReloadConfig()` reloads configuration and reinitializes RAG engine

### Environment Variables

All environment variables are configured and used on the **MCP server side**. MCP clients communicate with the server via the MCP protocol and do not directly access these variables.

**Core functionality (RAG Engine):**
- `DATABASE_URL`: PostgreSQL connection string (required)

**Embedding Provider (one required):**
- `OPENAI_API_KEY`: OpenAI API key
- `OLLAMA_BASE_URL`: Ollama server URL
- `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL`: OpenAI-compatible API
  - Note: OpenAI SDK automatically appends `/embeddings` to the base URL
  - Example: `https://example.com/v1` → requests to `https://example.com/v1/embeddings`
- `EMBEDDING_MODEL`: Embedding model to use (optional, auto-detected)

**RAG Configuration (all optional, have defaults):**

*Chunking:*
- `RAG_CHUNK_SIZE`: Chunk size in characters (default: 1000)
- `RAG_CHUNK_OVERLAP`: Chunk overlap in characters (default: 200)
- `RAG_CHUNK_LANGUAGE`: Chunking language (default: markdown)

*Search:*
- `RAG_MIN_SIMILARITY`: Minimum similarity threshold 0.0-1.0 (default: 0.7)
- `RAG_MAX_RESULTS`: Maximum search results (default: 10)
- `RAG_MAX_CHUNKS_PER_QUERY`: Maximum chunks per query (default: 5)

*Indexing:*
- `RAG_INCLUDE_PATTERNS`: Comma-separated glob patterns (default: "**/*.md,**/*.txt")
- `RAG_EXCLUDE_PATTERNS`: Comma-separated glob patterns (default: "**/node_modules/**,**/.git/**")

*Report:*
- `RAG_REPORT_OUTPUT_DIR`: Report output directory (default: rag-reports, automatically excluded from indexing)
- `RAG_MAX_QUOTE_LINES`: Maximum lines in quotes (default: 5)
- `RAG_REMOVE_BLANK_LINES`: Remove blank lines in reports (default: true)
- `RAG_DEFAULT_TEMPLATE`: Default template name (default: basic)

*Session:*
- `RAG_MAX_SESSION_RESULTS`: Maximum cached sessions (default: 10)

*Debug:*
- `RAG_DEBUG_LOG_ENABLED`: Enable debug logging (default: false)
- `RAG_DEBUG_LOG_PATH`: Debug log file path (default: /tmp/local-knowledge-rag-mcp/debug.log)

**.env File Support:**
- Project root `.env` file is automatically loaded on server startup
- Recommended for local development
- Alternative: Set in shell or Claude Desktop/Cline config

For detailed information about environment variable organization, security best practices, and troubleshooting, see [docs/environment-variables.md](docs/environment-variables.md).

### Default Values

- Embedding model: `text-embedding-3-small` (OpenAI)
- Chunk size: 1000 characters
- Chunk overlap: 200 characters
- Minimum similarity: 0.7
- Max search results: 10

## MCP Tool Specifications

### search_knowledge

- **Function**: Generates session ID from query, returns preview of top 5 results
- **Parameters**:
  - `query` (required): Search query string
  - `min_similarity` (optional): Minimum similarity threshold (0.0-1.0, default: 0.7)
  - `scope` (optional): Limit search scope (files, folders)
    - `files` (optional): Array of file paths (exact match)
    - `folders` (optional): Array of folder patterns (3 patterns supported)
      - Subdirectory name: `"hooks"` → `**/hooks/**`
      - Root-relative path: `"/src/hooks"` → `src/hooks/**`
      - Glob pattern: `"src/*/tests"` → used as-is
  - `limit`: Not configurable (internally fixed at 20 for caching)
- **Implementation Details**:
  - Always retrieves 20 results and caches in session
  - Returns progress information (index progress, searching, complete)
  - Executes automatic incremental update
  - Folder filtering performed in JavaScript (using minimatch library)
  - If both scope.files and scope.folders specified: AND condition
- **Returns**: session_id, result_count, top 5 results preview

### get_search_results

- **Function**: Get detailed results (full chunk content) from session ID
- **Supported Formats**:
  - Single session (backward compatibility)
  - Multiple session integration (new feature)
- **Parameters**:
  - `session_id` (optional): Single session ID
  - `session_ids` (optional): Array of multiple session IDs
  - `limit` (optional): Max chunks per session (default: 5)
- **Implementation Details**:
  - Default limit from configuration's `maxChunksPerQuery` or 5
  - Multiple sessions: returns metadata for each session
  - Results include file_uri, start_line, end_line
- **Returns**:
  - Single: query, total_results, returned_results, results array
  - Multiple: sessions array, total_results, results array

## MCP Resources

This MCP server provides **template schemas as MCP Resources**, allowing MCP clients (like Claude Code) to automatically access template variable definitions.

### Available Resources

- **`template://current/schema`** - Schema for the workspace default template (configured via `RAG_DEFAULT_TEMPLATE`)
  - Automatically reflects changes when `reload_config` updates the default template
  - Always points to the currently active default template
- **`template://basic/schema`** - Schema for the "basic" template
- **`template://paper/schema`** - Schema for the "paper" template
- **`template://bullet_points/schema`** - Schema for the "bullet_points" template

### Implementation Details

- **Handler**: `handleListResources()` and `handleReadResource(uri)`
- **Resource Format**: URI scheme `template://{name}/schema`
- **Content Type**: `application/json`
- **Dynamic Resolution**: `template://current/schema` resolves to the template specified in `RAG_DEFAULT_TEMPLATE` environment variable
- **Schema Source**: Reads from `{template}.md.json` files in the templates directory
- **Auto-reload**: Since template schemas are read dynamically (no caching), any changes to `.md.json` files are immediately reflected

### Benefits

1. **Automatic Discovery**: Claude Code can discover available template schemas without calling tools
2. **Always Up-to-date**: `template://current/schema` automatically points to the current default template
3. **Reduced API Calls**: Clients can cache resource data, reducing need for `get_template_schema` tool calls
4. **Better Integration**: Resources appear in MCP client's context, making schema information readily available

### get_template_schema (new feature)

- **Function**: Get template variable schema
- **Parameters**:
  - `template` (optional): Template name (default: "basic")
- **Implementation Details**:
  - Reads `{template}.md.json` from template directory
  - Parses JSON format metadata
  - Returns variable definitions, descriptions, examples
- **Returns**: TemplateMetadata (name, description, language, variables, example)
- **Available Templates**:
  - `basic`: Standard format (sections by file)
  - `paper`: Academic paper format (numbered citations [1], [2])
  - `bullet_points`: Bullet-point format

### create_rag_report (recommended)

- **Function**: Generate Markdown report using template-driven mode
- **Parameters**:
  - `variables` (required): Template-specific variables
    - Required fields typically include: query, generated_at, overall_summary, sections
    - Call `get_template_schema` if you need to see the exact schema for a specific template
  - `template` (optional): Template name
    - **RECOMMENDED**: Omit this parameter to use the workspace default template
    - Only specify if you need a different format (available: default, paper, bullet_points)
  - `output_dir` (optional): Output directory (default: "./rag-reports")
  - `file_name` (optional): Custom filename (.md extension, timestamp added as prefix)
  - `ascii_filename` (optional): Descriptive filename in English (ASCII only)
- **Implementation Details**:
  - Calls `handleGenerateAnswerV2`
  - Uses TemplateEngine.generateAnswerV2
  - Injects variables with processTemplateV2 ({{variable}} substitution and loop processing)
  - Generates report in format defined by template
  - If template is not specified, uses workspace default template from settings
- **Returns**: Generated report file path and content preview
- **Template System Benefits**:
  - Template defines output format
  - Multi-language support (fixed text within template outputs as-is)
  - Supports various citation styles (section format, paper format, bullet points, etc.)
  - Add new template to support new format
- **Note**: Legacy mode has been removed. V2 template-driven mode is now required.

### generate_report (deprecated)

- **Status**: Retained for backward compatibility
- **Recommendation**: Use `create_rag_report` instead
- **Parameters**: `session_id`, `overall_summary`, `sections`, `template`, `output_dir`, `file_name`

### list_search_results

- **Function**: List all cached sessions
- **Parameters**: None
- **Implementation Details**: Retrieves all sessions from SessionManager Map, sorts by timestamp descending
- **Returns**: Array of session ID, query, timestamp, result count

### rebuild_index

- **Function**: Rebuild or update index
- **Parameters**:
  - `reindex_all` (optional): Full rebuild or incremental update (default: false)
- **Implementation Details**:
  - Uses VectorManager for file scanning and chunking
  - Returns progress information in real-time with detailed tracking:
    - Percentage completion (e.g., "50%")
    - Chunk progress (e.g., "100/200 chunks")
    - File progress (e.g., "[5/10 files]")
    - Current file being processed (e.g., "- example.ts")
    - Progress updates are throttled to avoid excessive callbacks (500ms minimum interval)
  - Progress is logged to system temporary directory in JSON Lines format
  - Web-based progress viewer available at http://localhost:3456 (configurable)
  - Handles rate limit waits
- **Returns**: Processed file count, chunk count, detailed progress information with percentage and file tracking

### index_status

- **Function**: Get index status and statistics
- **Parameters**: None
- **Implementation Details**:
  - Database statistics (row count, data size)
  - Embedding model information
  - Number of indexed files
- **Returns**: isInitialized, totalFiles, indexedFiles, lastUpdated, embeddingModel, stats

### open_index_manager

- **Function**: Open the Index Manager in the default browser
- **Parameters**: None
- **Implementation Details**:
  - Retrieves actual Index Manager port from ProgressServer
  - Opens browser using platform-specific commands
  - Returns console URL
- **Returns**: Success message with URL or error

### reload_config

- **Function**: Reload configuration from .env file and reinitialize RAG engine without restarting MCP server
- **Parameters**: None
- **Implementation Details**:
  - Reloads .env file using `dotenv.config({ override: true })`
  - Saves reference to old RAG engine
  - Reinitializes RAG engine with new configuration
  - Cleans up old engine after successful initialization
  - Rolls back to old engine if reinitialization fails
  - Updates session manager if `RAG_MAX_SESSION_RESULTS` changed
- **Returns**: Success message with updated components or error message
- **Note**: Running Index Managers are not affected; use `stop_index_manager` and `open_index_manager` to restart them

### list_index_managers

- **Function**: List all running Index Manager processes across all workspaces
- **Parameters**: None
- **Implementation Details**:
  - Reads Index Manager registry file
  - Returns list of workspace IDs, paths, PIDs, ports, and start times
- **Returns**: List of running Index Managers or empty list

### stop_index_manager

- **Function**: Stop a specific Index Manager process
- **Parameters**:
  - `workspace_id` (string, required): Workspace ID of the Index Manager to stop
- **Implementation Details**:
  - Looks up Index Manager by workspace ID in registry
  - Sends SIGTERM signal to the process
  - Registry is automatically updated when process terminates
- **Returns**: Success message with workspace info or error if not found

## Error Handling

- Custom error classes (`RAGError`, `EmbeddingError`, `IndexingError`, `SearchError`)
- Exponential backoff for rate limits (using exponential-backoff library)
- Detailed error messages
- **EPIPE (Broken Pipe) Error Handling**
  - Occurs when parent process disconnects stdout/stderr pipes during shutdown
  - Safe logging wrapper (`safeLog`) prevents cascading failures
  - EPIPE errors are detected and handled gracefully without attempting to log
  - Process exits cleanly (exit code 0) when EPIPE is detected during normal shutdown
  - Prevents infinite error loops in uncaughtException handler
  - All signal handlers (SIGINT, SIGTERM) use safe logging to prevent EPIPE errors
- **Automatic Process Cleanup**
  - Monitors stdin for 'end' and 'close' events to detect parent process disconnection
  - When stdin closes, automatically calls `stop()` and exits gracefully
  - Prevents orphaned processes when MCP client fails to terminate the server
  - Uses `isShuttingDown` flag to prevent duplicate shutdown attempts
  - Defensive measure: client should terminate the server, but this provides safety net

## Performance Optimization

- Incremental updates accelerate index building
- LRU cache for session management
- Skip files based on modification time (mtime)
- pgvector's HNSW index for fast approximate nearest neighbor search
- Database-level vector similarity calculations
- Efficient cosine distance operator (<=>)

## Security Considerations

- API keys managed via environment variables
- Access only to local file system
- File pattern-based access restrictions
- Exclude `.git`, `node_modules`, etc.

## Dependencies

### Main Libraries

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `pg`: PostgreSQL client for Node.js
- `pgvector`: PostgreSQL extension for vector similarity search (server-side)
- `drizzle-orm`: TypeScript ORM
- `langchain`: Text chunking
- `glob`, `minimatch`: File pattern matching
- `exponential-backoff`: Retry handling
- `zod`: Schema validation

### PostgreSQL Extensions

- `pgvector`: Enables vector data type and similarity search operators
  - HNSW index for approximate nearest neighbor search
  - Cosine distance operator (<=>)
  - IVFFlat index as alternative option

## scope.folders Parameter Design and Implementation

- **Purpose**
  - Flexibly specify search target directories in search_knowledge scope parameter
  - Complements existing scope.files (exact match) functionality

- **Supports 3 Patterns**

  1. Subdirectory name specification
     - Format: `"hooks"`, `"components"`, `"tests"`, etc.
     - Conversion: `"hooks"` → `**/hooks/**`
     - Description: Search by directory name anywhere in workspace
     - Example: `"hooks"` matches `src/hooks/`, `lib/hooks/`, `docs/hooks/`

  2. Root-relative path (starts with /)
     - Format: `"/src/hooks"`, `"/docs/api"`, etc.
     - Conversion: `"/src/hooks"` → `src/hooks/**`
     - Description: Specify specific directory from project root
     - Example: `"/src/hooks"` matches only project's src/hooks

  3. Glob pattern
     - Format: `"src/*/hooks"`, `"**/tests/**"`, etc.
     - Conversion: Used as-is as glob pattern
     - Description: Flexible pattern matching
     - Example: `"src/*/hooks"` matches hooks under all src subdirectories

- **Implementation Details**
  - Utility functions: `src/utils/folder-utils.ts`
    - `convertFolderToGlob(folder: string): string`
    - `filterByFolders(results: SearchResult[], folders: string[]): SearchResult[]`
  - Processing location: `processQuery()` method in `src/core/rag-engine.ts`
  - Filtering: Executed in JavaScript (using minimatch library)
  - No database-level filtering (prioritizes flexibility)

- **AND/OR Conditions**
  - Multiple folders specified: OR condition (match any)
  - Both scope.files and scope.folders specified: AND condition (satisfy both)

- **Edge Cases**
  - Empty array: `folders: []` → No filtering (all files targeted)
  - Duplicate patterns: `["hooks", "src/hooks"]` → Search with both patterns (OR condition)
  - Non-existent directory: No error, result count is 0

## Multi-Workspace Support

### Overview

The system now supports multiple independent workspaces using the same PostgreSQL database. Each workspace is isolated from others, preventing data conflicts and enabling efficient resource sharing.

### Workspace Identification

Each workspace is uniquely identified by a `workspace_id`:

- **Generation**: SHA-256 hash of the normalized absolute workspace path (first 16 characters)
- **Properties**:
  - Deterministic: Same path always produces the same ID
  - Unique: Different paths produce different IDs
  - Platform-independent: Works on Windows, macOS, and Linux
  - Short: 16-character hex string

### Implementation Details

#### Database Schema

The `embeddings` table includes a `workspace_id` column:

```sql
CREATE TABLE embeddings (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,  -- Workspace identifier
  path TEXT NOT NULL,
  mtime BIGINT NOT NULL,
  content TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension SMALLINT NOT NULL,
  embedding vector(768) NOT NULL,
  metadata JSONB NOT NULL
);

CREATE INDEX embeddings_workspace_id_index ON embeddings (workspace_id);
```

#### Query Isolation

All database queries automatically filter by `workspace_id`:

```typescript
// VectorRepository adds workspace_id to all queries
const results = await this.db
  .select()
  .from(embeddingTable)
  .where(
    and(
      eq(embeddingTable.workspaceId, workspaceId),
      eq(embeddingTable.model, embeddingModel.id),
    ),
  )
```

#### Workspace ID Generation

Implemented in `src/utils/workspace-utils.ts`:

```typescript
function generateWorkspaceId(workspacePath: string): string {
  const normalizedPath = path.resolve(workspacePath)
  const canonicalPath = normalizedPath.replace(/\\/g, '/')
  const hash = crypto.createHash('sha256').update(canonicalPath).digest('hex')
  return hash.substring(0, 16)
}
```

### Usage

Multiple workspaces can share the same database:

```bash
# Workspace A
cd /path/to/workspace-a
export DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
npm run dev

# Workspace B (separate terminal)
cd /path/to/workspace-b
export DATABASE_URL=postgresql://user:password@localhost:5432/rag_db
npm run dev
```

### Migration

See `scripts/WORKSPACE_MIGRATION.md` for detailed migration instructions.

### Concurrency Control

The system uses PostgreSQL advisory locks to prevent concurrent index updates from corrupting data:

#### Problem

When multiple MCP server processes attempt to update the same workspace simultaneously:
- Race conditions occur between `clearAllVectors()` and `insertVectors()`
- Partial deletions and insertions can interleave
- Database ends up with inconsistent or corrupted index data

#### Solution: PostgreSQL Advisory Locks

**Implementation** (`src/core/vector-repository.ts`):

```typescript
// Acquire exclusive lock for workspace
async acquireAdvisoryLock(workspaceId: string): Promise<void> {
  const lockKey = this.workspaceIdToLockKey(workspaceId)
  await this.db.execute(sql`SELECT pg_advisory_lock(${lockKey})`)
}

// Release lock
async releaseAdvisoryLock(workspaceId: string): Promise<void> {
  const lockKey = this.workspaceIdToLockKey(workspaceId)
  await this.db.execute(sql`SELECT pg_advisory_unlock(${lockKey})`)
}

// Helper to execute function within lock
async withAdvisoryLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  await this.acquireAdvisoryLock(workspaceId)
  try {
    return await fn()
  } finally {
    await this.releaseAdvisoryLock(workspaceId)
  }
}
```

**Lock Key Generation**:
- Workspace ID string is hashed to a 32-bit integer for PostgreSQL compatibility
- Same workspace always produces the same lock key
- Different workspaces get different lock keys

**Usage in VectorManager** (`src/core/vector-manager.ts`):

```typescript
async updateVaultIndex(...): Promise<void> {
  // Wrap entire update operation in advisory lock
  await this.repository.withAdvisoryLock(this.workspaceId, async () => {
    await this.updateVaultIndexInternal(...)
  })
}
```

#### Benefits

1. **Process-level isolation**: Multiple server processes can safely update the same workspace
2. **Automatic blocking**: Second server waits until first completes
3. **No configuration required**: Works automatically with PostgreSQL
4. **Database-level guarantee**: Lock is held at database level, survives process crashes
5. **Workspace-specific**: Different workspaces can update concurrently

#### Behavior

| Scenario | Behavior |
|----------|----------|
| Single server updating | Proceeds immediately |
| Multiple servers, different workspaces | All proceed concurrently |
| Multiple servers, same workspace | First acquires lock, others wait |
| Server crashes mid-update | Lock automatically released by PostgreSQL |

#### In-Process Concurrency Control

In addition to PostgreSQL advisory locks for inter-process synchronization, the system implements in-process synchronization to prevent multiple concurrent rebuild requests within a single MCP server process:

**Problem**: When multiple directories trigger rebuild requests simultaneously (e.g., file changes in multiple folders), multiple HTTP requests arrive at the ProgressServer endpoint, potentially causing:
- Race conditions between concurrent async operations
- Conflicting cancellation states
- Resource exhaustion from multiple simultaneous indexing operations

**Solution**: Mutex-based exclusive locking using the `async-mutex` library (`src/mcp-server.ts`):

```typescript
// Try to acquire exclusive lock (non-blocking)
const release = await this.indexMutex.tryAcquire()
if (!release) {
  // Lock already held - reject concurrent request immediately
  return { isError: true, ... }
}

// Lock acquired - we have exclusive access
try {
  // Perform indexing operation
  await this.ragEngine.updateVaultIndex(...)
} finally {
  release() // Always release lock, even on error
}
```

**Key Properties**:
1. **Thread-safe mutex**: Uses proven `async-mutex` library instead of manual flag management
2. **Non-blocking tryAcquire()**: Immediate rejection of concurrent requests with HTTP 409 status
3. **Guaranteed cleanup**: Lock automatically released via finally block, even on errors or exceptions
4. **Future-proof**: Works correctly regardless of code changes (adding await points, etc.)

**Why Mutex Instead of Boolean Flag**:
- Boolean flags with check-then-set pattern are inherently racy in async code
- Manual flag management breaks if someone adds an `await` between check and set
- Mutex provides formal mutual exclusion semantics that can't be accidentally broken
- Standard library solution is more maintainable and easier to understand

**Interaction with Advisory Locks**:
- In-process mutex prevents concurrent requests within one server process
- PostgreSQL advisory lock prevents concurrent updates across multiple server processes
- Both mechanisms work together for complete concurrency safety at all levels

#### Performance Impact

- Minimal overhead for single-server usage
- Lock acquisition is fast (microseconds)
- Waiting servers block until lock is released (may wait minutes during large updates)
- No data corruption or retry logic needed
- Concurrent rebuild requests are rejected immediately (HTTP 409) rather than queued

## Future Extension Possibilities

- Support for additional embedding providers
- Extended custom template support
- Query history persistence
- More advanced search filtering
- Workspace management UI (list, switch, delete workspaces)
