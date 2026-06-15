# Local Knowledge RAG MCP Server

**A semantic search and retrieval system for local documents using vector embeddings. Powered by MCP (Model Context Protocol).**

> This project is based on the RAG implementation from [Obsidian Smart Composer](https://github.com/glowingjade/obsidian-smart-composer).
> We've adapted it to focus on local document search and knowledge management as a standalone MCP server.

Provides semantic search across your local documents using vector embeddings and similarity search, with support for multiple embedding providers (OpenAI, Ollama, and OpenAI-compatible APIs).

---

## Overview

Local Knowledge RAG MCP Server enables AI-powered semantic search of your local document collections. Rather than keyword-based search, it understands the meaning of your queries and finds relevant content through vector embeddings.

**Key capabilities:**
- Semantic search powered by vector embeddings
- Support for multiple embedding providers (OpenAI, Ollama, LiteLLM, and any OpenAI-compatible APIs)
- Session-based search result caching
- Customizable report generation with multiple templates
- PostgreSQL with pgvector for high-performance vector similarity search
- HNSW indexing for fast approximate nearest neighbor search
- Incremental indexing and full rebuilds

---

## Why This Project?

While experimenting with various RAG (Retrieval-Augmented Generation) solutions like Dify and RAGFlow, we encountered several limitations:

1. **High Knowledge Base Management Cost**: Adding, removing, and updating documents required time-consuming manual steps
2. **Poor Citation Usability**: Citations referenced internal knowledge base resources rather than actual source files, making them difficult to work with
3. **Limited Output Format Flexibility**: Report generation was rigid and couldn't be easily customized

**Obsidian Smart Composer** solved problems #1 and #2 beautifully by working directly with your local files. This inspired us to bring that same experience to VS Code, where many developers spend most of their time.

**What makes Local Knowledge RAG MCP Server unique:**

- **Flexible Report Templates**: Customize RAG output format freely with template files (unlike rigid output formats in other solutions)
- **Scalable to Large Knowledge Bases**: Uses PostgreSQL's pgvector extension for efficient vector similarity search, handling large document collections
- **Built-in Index Manager**: Web-based interface for monitoring indexing progress and managing your knowledge base
- **VS Code Integration**: Seamless integration with Claude Code extension, bringing RAG capabilities directly into your development workflow

---

## Recommended Environment

This MCP server is optimized for the following environment:

- **IDE**: [VS Code](https://code.visualstudio.com/)
- **Extension**: [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- **AI Model**: Claude Sonnet 4.5 (latest)

While the server works with any MCP-compatible client, the above combination provides the best experience with optimal performance and integration.

---

## Quick Start

Get up and running in 5 steps:

### 1. Set up PostgreSQL with pgvector

**Using Docker (easiest):**
```bash
docker run -d \
  --name local-knowledge-rag-db \
  -e POSTGRES_DB=local_knowledge_rag \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  -v local-knowledge-rag-data:/var/lib/postgresql/data \
  --restart unless-stopped \
  ankane/pgvector
```

> **Note:** The credentials above are for local development only. If port 5432 is already in use, change the host port (e.g., `-p 5433:5432`) and update `DATABASE_URL` accordingly.

### 2. Clone and build the project

```bash
git clone https://github.com/patakuti/local-knowledge-rag-mcp.git
cd local-knowledge-rag-mcp
npm install
npm run build
```

### 3. Configure environment variables

```bash
# Copy the example file
cp .env.example .env

# Edit .env with your settings
# Minimal configuration:
DATABASE_URL=postgresql://user:password@localhost:5432/local_knowledge_rag

# Choose ONE embedding provider:
# Option A: OpenAI
OPENAI_API_KEY=sk-your-openai-api-key

# Option B: LiteLLM (recommended - supports multiple providers)
OPENAI_COMPATIBLE_BASE_URL=http://localhost:4000/v1
OPENAI_COMPATIBLE_API_KEY=your-litellm-key
EMBEDDING_MODEL=cl-nagoya/ruri-v3-310m

# Option C: Ollama (local, offline)
OLLAMA_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

### 4. Add to Claude Code

Add this MCP server to Claude Code:

```bash
# Add globally (available in all projects)
claude mcp add -s user local-knowledge-rag -- node /path/to/local-knowledge-rag-mcp/dist/mcp-server.js

# Add to a specific project
cd /path/to/your/project
claude mcp add local-knowledge-rag -- node /path/to/local-knowledge-rag-mcp/dist/mcp-server.js
```

**Note:** Environment variables are loaded from `.env` file automatically. Do not add them to MCP server configuration for security reasons.

### 5. Start using it!

Restart Claude Code and start a conversation:

1. **Open Index Manager**: Say to Claude: "Open the Index Manager"
2. **Build Index**: In the web interface that opens, click "Update Index" button
3. **Start Searching**: Say to Claude: "Search my documents for information about [your topic] and create a report"

That's it! Claude will use the RAG tools automatically to search your documents and generate reports.

See [Usage Examples](#usage-examples) for more details.

---

## Features

- **Semantic Search**: Uses vector embeddings to find semantically similar content
- **Multiple Embedding Providers**: OpenAI, Ollama, or any OpenAI-compatible API
- **Multi-Workspace Support**: Use the same database for multiple independent workspaces
- **Session Management**: Cache and reuse search results across multiple queries
- **Template-Driven Reports**: Generate formatted Markdown reports with customizable templates
- **pgvector Extension**: High-performance vector similarity search with PostgreSQL
- **HNSW Indexing**: Fast approximate nearest neighbor search for large datasets
- **Flexible File Patterns**: Include/exclude file patterns for fine-grained control
- **MCP Integration**: Seamless integration with Claude Code and other MCP clients
- **Real-time Progress Tracking**: Web-based progress viewer showing live updates during index operations with percentage completion, file count, and current file being processed

---

## Configuration

All configuration is done via environment variables in a `.env` file. See [Quick Start](#quick-start) for basic setup.

**Common configuration tasks:**
- **Changing embedding models**: Edit `.env`, run `reload_config` tool, then rebuild index
- **Adjusting search parameters**: Edit `.env` RAG settings, restart MCP server
- **File patterns**: Edit `RAG_INCLUDE_PATTERNS` and `RAG_EXCLUDE_PATTERNS` in `.env`

**For complete configuration reference, see [docs/configuration.md](docs/configuration.md).**

---

## Multi-Workspace Support

Multiple workspaces can share the same PostgreSQL database. Each workspace automatically maintains its own isolated index based on its absolute path.

**Key Features:**
- ✅ Multiple workspaces share the same `DATABASE_URL` (configured in `.env`)
- ✅ Each workspace has its own isolated index (no data conflicts)
- ✅ Concurrent updates are safe (protected by PostgreSQL advisory locks)

Just use the same database for all your projects - the system handles workspace isolation automatically.

---

## Usage Examples

### Creating the Index

Before you can search, you need to create an index of your documents:

1. Say to Claude: "Open the Index Manager"
2. In the web interface, click the **"Update Index"** button to index your documents
3. Wait for indexing to complete - you'll see real-time progress in the interface

**Note:** The Index Manager will only index files matching your patterns (default: `**/*.md` and `**/*.txt`). You can change these patterns in your `.env` file.

### Searching Your Documents

Once your index is ready, just talk to Claude naturally:

**Simple search:**
- "Search my documents for information about React hooks and create a report"
- "Find documentation about database setup and create a summary"
- "Look for examples of error handling and create a report"

**Search in specific folders:**
- "Search the /src/components folder for button implementations and create a report"
- "Find configuration examples in the docs directory and create a summary"

**Advanced analysis:**
- "Search for React patterns and create a detailed summary report"
- "Analyze my database schema and generate documentation"

Claude will automatically:
1. Search your indexed documents
2. Find relevant content based on semantic similarity
3. Generate a formatted Markdown report
4. Save the report to `./rag-reports/` directory

**Advanced:** For direct MCP tool usage and detailed parameters, see [docs/mcp-tools.md](docs/mcp-tools.md).

**Report customization:** Reports are saved to `./rag-reports/` by default. You can create custom templates (built-in: `basic`, `paper`, `bullet_points`, `manual`) - see [docs/templates.md](docs/templates.md).

---

## Available MCP Tools

**Search & Reports:**
- `search_knowledge` - Perform semantic search
- `get_search_results` - Retrieve detailed results
- `create_rag_report` - Generate Markdown reports
- `list_search_results` - List cached sessions

**Indexing:**
- `rebuild_index` - Rebuild document index
- `cancel_index_generation` - Cancel indexing
- `index_status` - Check index status

**Management:**
- `reload_config` - Reload .env configuration
- `open_index_manager` - Open web UI
- `reinitialize_schema` - Reset workspace (⚠️ destructive)

**For detailed parameters and examples, see [docs/mcp-tools.md](docs/mcp-tools.md).**

---

## Index Manager

Web-based interface for monitoring indexing progress and managing your knowledge base. Runs as an independent process on localhost:3456 (or next available port).

**Access:** Say to Claude "Open the Index Manager" or use `open_index_manager` tool

**Features:** Real-time progress tracking, project statistics, index operations (update/rebuild/cancel)

**Logs:** `/tmp/local-knowledge-rag-mcp/{workspaceId}/index-manager.log`

---

## CLI Tool (`lkrag`)

A command-line interface for index management and search, suitable for cron jobs, editor integrations, and automation.

### Installation

After building the project, install globally or use via `npx`:

```bash
npm run build
npm link   # makes lkrag available in PATH
```

### Commands

```
lkrag search <query>       Search indexed documents
lkrag update-index         Incrementally update the index
lkrag rebuild-index        Rebuild the entire index from scratch
lkrag status               Show index status
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--workspace-path <path>` | current directory | Workspace to operate on |
| `--find-workspace` | — | Traverse up from current directory to find an indexed workspace |
| `--limit <n>` | 5 | Number of search results |
| `--min-similarity <n>` | 0.3 | Minimum similarity score (0–1) |
| `--format <fmt>` | plain | Output format: `plain`, `tsv`, `json` |
| `--quiet` | — | Suppress informational messages on stderr |
| `--env-file <path>` | — | Load additional .env file |

### Examples

```bash
# Search with plain output
lkrag search "authentication flow" --workspace-path /path/to/docs

# Search from a subdirectory — finds the nearest indexed ancestor automatically
lkrag search "error handling" --find-workspace

# TSV output for editor integration (path, line, score, content)
lkrag search "setup guide" --format tsv --limit 10

# JSON output for scripting
lkrag search "database schema" --format json | jq '.[0].path'

# Update index from a subdirectory
lkrag update-index --find-workspace

# Schedule index updates via cron (daily at 3am)
# 0 3 * * * node /path/to/dist/cli.js update-index --workspace-path /path/to/docs

# Check index status
lkrag status
```

### Emacs Integration Example

Results are displayed in a persistent `*rag-results*` buffer.

| Key | Action |
|-----|--------|
| `n` / `p` | Next/previous result — previews the file in other window, focus stays on results |
| `RET` | Open selected file full-screen (`delete-other-windows`) |
| `q` | Close results buffer |

```elisp
;;; lkrag integration

(defvar rag-workspace-path nil
  "Explicit lkrag workspace path.
When nil (default), --find-workspace is used to locate the nearest
indexed ancestor directory automatically.
Example: (setq rag-workspace-path \"~/etc/txt/myproject/\")")

(defvar rag-results-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "n")   #'rag-results-next)
    (define-key map (kbd "p")   #'rag-results-prev)
    (define-key map (kbd "RET") #'rag-results-open)
    (define-key map (kbd "q")   #'quit-window)
    map))

(define-derived-mode rag-results-mode special-mode "RAG"
  "Major mode for lkrag search results.
\\{rag-results-mode-map}")

(defun rag-results--loc ()
  "Return (path . line) for the result at point, or nil."
  (get-text-property (line-beginning-position) 'rag-location))

(defun rag-results--preview ()
  "Show file at point in other window; focus stays on results buffer."
  (when-let ((loc (rag-results--loc)))
    (save-selected-window
      (find-file-other-window (car loc))
      (goto-line (cdr loc))
      (recenter))))

(defun rag-results-open ()
  "Open result at point full-screen."
  (interactive)
  (when-let ((loc (rag-results--loc)))
    (find-file-other-window (car loc))
    (goto-line (cdr loc))
    (recenter)
    (delete-other-windows)))

(defun rag-results-next ()
  "Move to the next result and preview it."
  (interactive)
  (let ((pos (save-excursion
               (forward-line 1)
               (while (and (not (eobp)) (null (rag-results--loc)))
                 (forward-line 1))
               (and (rag-results--loc) (point)))))
    (when pos
      (goto-char pos)
      (rag-results--preview))))

(defun rag-results-prev ()
  "Move to the previous result and preview it."
  (interactive)
  (let ((pos (save-excursion
               (forward-line -1)
               (while (and (not (bobp)) (null (rag-results--loc)))
                 (forward-line -1))
               (and (rag-results--loc) (point)))))
    (when pos
      (goto-char pos)
      (rag-results--preview))))

(defun rag-search (query)
  "Search lkrag index and display results in *rag-results* buffer."
  (interactive "sSearch: ")
  (let* ((explicit-workspace (and rag-workspace-path
                                  (expand-file-name rag-workspace-path)))
         (current-dir (expand-file-name default-directory))
         (lkrag (or (executable-find "lkrag")
                    (expand-file-name "~/.npm-global/bin/lkrag")))
         (stderr-file (make-temp-file "lkrag-stderr"))
         (cmd (if explicit-workspace
                  (format "%s search %s --format tsv --limit 50 --quiet --workspace-path %s 2>%s"
                          lkrag
                          (shell-quote-argument query)
                          (shell-quote-argument explicit-workspace)
                          (shell-quote-argument stderr-file))
                (format "%s search %s --format tsv --limit 50 --find-workspace 2>%s"
                        lkrag
                        (shell-quote-argument query)
                        (shell-quote-argument stderr-file))))
         (output (shell-command-to-string cmd))
         (stderr (prog1 (with-temp-buffer
                          (insert-file-contents stderr-file)
                          (buffer-string))
                   (delete-file stderr-file)))
         (found-workspace (when (string-match "^\\[lkrag\\] workspace: \\(.*\\)" stderr)
                            (match-string 1 stderr)))
         ;; When --find-workspace returned a parent of current-dir, filter to current-dir
         (filter-to-current (and (null explicit-workspace)
                                 found-workspace
                                 (not (string= (file-truename found-workspace)
                                               (file-truename current-dir)))))
         ;; expand-root: workspace root used to resolve lkrag's relative paths
         ;; display-root: shown in From: header and used for file-relative-name
         (expand-root (or explicit-workspace found-workspace current-dir))
         (display-root (if filter-to-current current-dir expand-root))
         (all-tsv-lines (seq-filter (lambda (l) (string-match-p "\t" l))
                                    (split-string (string-trim output) "\n" t)))
         (tsv-lines (if filter-to-current
                        (seq-filter
                         (lambda (line)
                           (let* ((parts (split-string line "\t"))
                                  (path (expand-file-name (nth 0 parts) expand-root)))
                             (string-prefix-p (file-truename current-dir)
                                              (file-truename path))))
                         all-tsv-lines)
                      all-tsv-lines))
         (buf (get-buffer-create "*rag-results*")))
    (with-current-buffer buf
      (let ((inhibit-read-only t))
        (erase-buffer)
        (rag-results-mode)
        (insert (propertize (format "Search: %s\n" query) 'face 'bold))
        (insert (propertize (format "From:   %s\n\n" display-root) 'face 'shadow))
        (if (null tsv-lines)
            (insert "No results found.\n")
          (dolist (line tsv-lines)
            (let* ((parts   (split-string line "\t"))
                   (path    (expand-file-name (nth 0 parts) expand-root))
                   (lineno  (string-to-number (nth 1 parts)))
                   (score   (nth 2 parts))
                   (content (nth 3 parts))
                   (relpath (file-relative-name path display-root))
                   (excerpt (truncate-string-to-width content 60))
                   (start   (point)))
              (insert (propertize relpath 'face 'compilation-info)
                      (propertize (format ":%d" lineno) 'face 'compilation-line-number)
                      (propertize (format " [%s] " score) 'face 'shadow)
                      excerpt "\n")
              (put-text-property start (point) 'rag-location (cons path lineno)))))
        (goto-char (point-min))
        (forward-line 3)))
    (pop-to-buffer buf)
    (rag-results--preview)))

;; Optional key binding
;; (global-set-key (kbd "C-c r") #'rag-search)
```

Notes:
- `rag-workspace-path` — set only when the indexed root differs from the directory you work in. When nil, `--find-workspace` locates the nearest indexed ancestor automatically.
- When `--find-workspace` is used, lkrag prints the resolved workspace path to stderr (`[lkrag] workspace: /path/to/ws`). The Emacs integration captures this via a temp file to display the correct `From:` path and compute relative paths accurately.
- When `--find-workspace` resolves to a parent of `default-directory` (i.e. the current directory is not itself indexed), results are automatically filtered to files under `default-directory`. The search fetches 50 candidates upfront to leave enough headroom after filtering. `From:` and relative paths are shown relative to `default-directory` in this case.
- `expand-file-name` ensures `~` is resolved before passing to the shell, avoiding single-quote quoting issues.
- The `*rag-results*` buffer persists across searches; each new search overwrites it.

### VS Code Integration Example

A minimal VS Code extension is included in `vscode-extension/`. It opens a **QuickPick** search panel where results are previewed as you navigate, and Enter opens the selected file at the matching line.

**Installation**

```bash
# From the repo root — link or copy into VS Code's extensions directory
ln -s "$(pwd)/vscode-extension" ~/.vscode/extensions/lkrag-search-0.1.0
# Then reload VS Code (Developer: Reload Window)
```

Alternatively, package as a `.vsix` and install via the Extensions sidebar:

```bash
npm install -g @vscode/vsce
cd vscode-extension
vsce package          # produces lkrag-search-0.1.0.vsix
# Extensions sidebar → ⋯ → Install from VSIX…
```

**Usage**

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **lkrag: Search**.

- Type a query — results appear after a short debounce
- Arrow keys move through results; the file is previewed in the editor
- `Enter` opens the selected file at the matching line
- `Escape` cancels

**Keybinding (optional)**

Add to `keybindings.json` (`Ctrl+Shift+P` → "Open Keyboard Shortcuts (JSON)"):

```json
{ "key": "ctrl+alt+r", "command": "lkrag.search" }
```

**Settings**

| Setting | Default | Description |
|---------|---------|-------------|
| `lkrag.workspacePath` | `""` | Explicit workspace path. Leave empty to use `--find-workspace`. |
| `lkrag.executablePath` | `""` | Path to `lkrag` binary. Leave empty to auto-detect. |
| `lkrag.limit` | `20` | Maximum number of results. |

Notes:
- `lkrag.workspacePath` — set only when the indexed root differs from the directory you work in. When empty, `--find-workspace` locates the nearest indexed ancestor automatically.
- The extension has no npm dependencies; no `npm install` is required before use.
- The VS Code extension host inherits PATH from the environment VS Code was launched in. If `lkrag` is not found, set `lkrag.executablePath` explicitly.

### Index Update Behavior

- If an **Index Manager** server is running for the workspace, `update-index` and `rebuild-index` delegate to it via HTTP (non-blocking).
- If no server is running, the CLI runs the operation **directly** with progress output to stderr.

---

## Troubleshooting

### Documents not being indexed

1. Check logs: `/tmp/local-knowledge-rag-mcp/{workspaceId}/index-manager.log`
2. Verify `.env` configuration (DATABASE_URL, API keys)
3. Check file patterns: `RAG_INCLUDE_PATTERNS` and `RAG_EXCLUDE_PATTERNS`

### No search results

- Try different search terms or lower similarity threshold
- Verify indexing completed: use `index_status` tool
- Rebuild index if needed

### API errors

- Verify API key is valid and has correct permissions
- Check rate limits (switch to Ollama if needed)

### Switching embedding models

1. Edit `.env` with new model settings
2. Run `reload_config` tool
3. Run `rebuild_index` with `reindex_all: true`

**For complete troubleshooting guide, see [docs/troubleshooting.md](docs/troubleshooting.md).**

---

## Security

### API Key Management

- **Never commit API keys** to version control
- Use `.env` files locally and `.env.example` in the repository
- Rotate keys regularly
- Use environment-specific keys when possible

### Network Security

- **Index Manager (Web UI)**: Binds to `127.0.0.1:3456` (loopback only) without authentication
  - Not accessible from external networks by default
  - Designed for trusted local development environments only

### Local Data Handling

- All documents are processed locally by default
- Embeddings are stored in PostgreSQL database
- Progress logs are stored in system temporary directory
- Ensure proper database access control and backup
- Database connections should only be allowed from trusted networks

### Best Practices

- Review `.gitignore` to ensure sensitive files are excluded
- For sensitive data, consider using Ollama for fully offline, local processing
- Regularly rotate API keys and monitor API usage for unusual patterns

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Note:** This project is maintained on a limited-time basis. PR reviews may take several weeks. Security issues are prioritized.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Credits

- [Obsidian Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) - Original RAG implementation
- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/specification)
- [Claude Code](https://claude.com/claude-code)
