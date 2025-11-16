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
  ankane/pgvector
```

**Or install locally:** See [PostgreSQL Setup](#postgresql-setup) for detailed instructions.

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

Add this MCP server to your Claude Code configuration:

```json
{
  "mcpServers": {
    "local-knowledge-rag": {
      "command": "node",
      "args": ["/path/to/local-knowledge-rag-mcp/dist/src/mcp-server.js"]
    }
  }
}
```

**Note:** Environment variables are loaded from `.env` file automatically. Do not add them to this configuration for security reasons.

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

**Report customization:** Reports are saved to `./rag-reports/` by default. You can create custom templates - see [docs/templates.md](docs/templates.md).

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

- **Index Manager (Web UI)**: Runs on localhost:3456 without authentication
  - Designed for trusted local development environments only
  - Do not expose to untrusted networks via port forwarding or reverse proxies
  - If external access is needed, implement proper authentication and access controls

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
