#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, join, resolve, relative } from 'path'
import { config } from 'dotenv'
import os from 'os'
import lockfile from 'proper-lockfile'

// Load .env file from project root (one level up from dist/)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const envPath = join(__dirname, '..', '.env')
const envResult = config({ path: envPath })

// Warn if .env file is not found (but don't fail - env vars might be set elsewhere)
if (envResult.error) {
  console.error('')
  console.error('⚠️  No .env file found at:', envPath)
  console.error('⚠️  Environment variables must be set via:')
  console.error('    1. Create .env file: cp .env.example .env')
  console.error('    2. Or set them in Claude Desktop/Cline config')
  console.error('    3. Or export them in your shell')
  console.error('')
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ListResourcesRequest,
  type ReadResourceRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'child_process'
import { Mutex, tryAcquire } from 'async-mutex'
import { RAGEngine, createRAGEngineFromConfig } from './core/rag-engine.js'
import { SessionManagerImpl } from './core/session-manager.js'
import { TemplateEngine } from './core/template-engine.js'
import { generateWorkspaceId, getWorkspaceTempDir } from './utils/workspace-utils.js'
import { ProgressServer } from './utils/progress-server.js'
import { BrowserFlag } from './utils/browser-flag.js'
import { ProgressServerFlag } from './utils/progress-server-flag.js'
import { IndexManagerRegistry } from './utils/index-manager-registry.js'
import { sanitizeQuery } from './utils/log-sanitizer.js'
import type {
  VaultSearchParams,
  RebuildIndexParams,
  GenerateAnswerParams,
  QueryProgressState,
  CancellationController
} from './types/rag.types.js'

/**
 * Local Knowledge RAG MCP Server
 */
class SmartComposerRAGServer {
  private server: Server
  private ragEngine: RAGEngine | null = null
  private sessionManager: SessionManagerImpl
  private templateEngine: TemplateEngine
  private progressServer: ProgressServer | null = null
  private browserOpened: boolean = false
  private browserFlag: BrowserFlag
  private progressServerFlag: ProgressServerFlag | null = null
  private indexCancellationController: CancellationController
  private indexMutex = tryAcquire(new Mutex())
  private isShuttingDown: boolean = false

  constructor() {
    this.sessionManager = new SessionManagerImpl(10)
    // Use absolute path to templates directory (from project root)
    // __dirname is dist, so we need to go up one level to reach project root
    const templatesPath = join(__dirname, '..', 'templates')
    this.templateEngine = new TemplateEngine(templatesPath)
    // BrowserFlag will be initialized after RAGEngine is created (to get workspace ID)
    this.browserFlag = new BrowserFlag() // Temporary, will be replaced

    // Initialize cancellation controller for index generation
    this.indexCancellationController = {
      isCancelled: false,
      cancel: () => {
        console.error('[CancellationController.cancel] Setting isCancelled to true')
        this.indexCancellationController.isCancelled = true
        console.error('[CancellationController.cancel] isCancelled is now:', this.indexCancellationController.isCancelled)
      },
      reset: () => {
        console.error('[CancellationController.reset] Resetting isCancelled to false')
        this.indexCancellationController.isCancelled = false
      }
    }

    this.server = new Server(
      {
        name: 'local-knowledge-rag',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    )

    this.setupToolHandlers()
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
      return {
        tools: [
          {
            name: 'search_knowledge',
            description: '⚠️ BEFORE using this tool: ALWAYS call list_search_results first to check existing searches. If relevant searches exist, use get_search_results with multiple session_ids instead. Only create NEW searches if necessary. This tool performs semantic search in the workspace (NOT web search) to find relevant files, documents, and code. Returns a session ID. WORKFLOW: list_search_results → (if needed) search_knowledge → get_search_results → create_rag_report.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query to find semantically similar content',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results to return (fixed: 20, not user-configurable)',
                  default: 20,
                },
                min_similarity: {
                  type: 'number',
                  description: 'Minimum similarity threshold (0.0-1.0, default: 0.7)',
                  default: 0.7,
                },
                scope: {
                  type: 'object',
                  description: 'Optional scope to limit search to specific files or folders',
                  properties: {
                    files: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Specific file paths to search within',
                    },
                    folders: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Folder paths to search within',
                    },
                  },
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'generate_report',
            description: '[DEPRECATED] Use create_rag_report instead. Generate a formatted Markdown report from analyzed search results. Requires overall summary and sections with quotes.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: {
                  type: 'string',
                  description: 'Search session ID',
                },
                overall_summary: {
                  type: 'string',
                  description: 'Overall summary of findings',
                },
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      file_path: { type: 'string' },
                      summary: { type: 'string' },
                      quote: { type: 'string' },
                      start_line: { type: 'number' },
                      end_line: { type: 'number' },
                    },
                    required: ['file_path', 'summary', 'quote'],
                  },
                },
                template: { type: 'string' },
                output_dir: { type: 'string' },
                file_name: { type: 'string' },
              },
              required: ['session_id', 'overall_summary', 'sections'],
            },
          },
          {
            name: 'create_rag_report',
            description: '⭐ RECOMMENDED: Generate a comprehensive markdown report using template-driven mode. ⚡ QUICK START: Just provide variables and omit template parameter to use the workspace default template. 📋 IMPORTANT: Before calling this tool, check the template schema via MCP Resources (template://current/schema) to understand required variables. Alternatively, call get_template_schema tool. WORKFLOW: (1) Check template schema (template://current/schema or template://{name}/schema), (2) Prepare variables (query, generated_at, overall_summary, sections), (3) Call create_rag_report with variables only (template parameter is optional - omit it unless you need a specific template format). ⚠️ CRITICAL OUTPUT RULE: After calling this tool, you MUST output EXACTLY these 2 lines to the user (and NOTHING else - no explanations, no additional text, no summaries): "# Report Generated Successfully" and "🔗 **Link**: [filename](path)". Copy them verbatim from the tool response.',
            inputSchema: {
              type: 'object',
              properties: {
                variables: {
                  type: 'object',
                  description: 'Template variables. Check MCP Resources (template://current/schema) for exact schema. Typically includes: query, generated_at, overall_summary, sections (array with file_name_with_line, file_uri, section_summary, section_quote).',
                },
                template: {
                  type: 'string',
                  description: 'Optional template name. RECOMMENDED: Omit this parameter to use the workspace default template. Only specify if you need a different format (available: basic, paper, bullet_points). Check MCP Resources (template://{name}/schema) or call get_template_schema to see details.',
                  default: 'basic',
                },
                output_dir: {
                  type: 'string',
                  description: 'Output directory (default: value from RAG_REPORT_OUTPUT_DIR environment variable, or "./rag-reports" if not set)',
                  default: './rag-reports',
                },
                file_name: {
                  type: 'string',
                  description: 'Custom filename with .md extension (timestamp prefix added automatically). Deprecated: Use ascii_filename instead for better control.',
                },
                ascii_filename: {
                  type: 'string',
                  description: 'Descriptive filename in English (ASCII only) with .md extension. Use underscores or hyphens, e.g., "obsidian_revolutionary_features.md". Timestamp prefix will be added automatically. This takes priority over file_name.',
                },
              },
              required: ['variables'],
            },
          },
          {
            name: 'get_search_results',
            description: 'Get detailed search results from one or multiple session IDs. Returns chunks with their content and metadata. Each result includes: (1) content: the chunk text, (2) start_line/end_line: the line range of this CHUNK in the original file. IMPORTANT: When you quote a portion of the chunk in create_rag_report, calculate the actual line number where YOUR QUOTE starts (not the chunk start). For example, if chunk is L10-L50 and your quote starts at the 5th line of the chunk, use start_line=14 (10+4). WORKFLOW: Use this after search_knowledge to retrieve content, then MUST call create_rag_report to create the final report. ⚠️ DO NOT specify the "limit" parameter unless the user explicitly requests a different number of results.',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: {
                  type: 'string',
                  description: 'Single session ID (for backward compatibility)',
                },
                session_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Multiple session IDs to combine results from different searches',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of chunks to retrieve per session. Default is 5 chunks per session. ONLY specify this parameter if the user explicitly requests a different number (e.g., "show me 10 results"). Otherwise, omit this parameter to use the default.',
                  default: 5,
                },
              },
            },
          },
          {
            name: 'list_search_results',
            description: '🔍 ALWAYS CALL THIS FIRST when user asks to search: Lists all cached search sessions with their queries, IDs, and result counts. Use this to: (1) Check if a similar search already exists, (2) Identify multiple relevant sessions to combine with get_search_results, (3) Avoid redundant searches. If you find relevant existing searches, use get_search_results with session_ids array to combine them instead of creating new searches.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'rebuild_index',
            description: 'Rebuild or update the RAG search index for the workspace. Use when files have been added/modified or when search results seem outdated. (Note: This is a heavy operation)',
            inputSchema: {
              type: 'object',
              properties: {
                reindex_all: {
                  type: 'boolean',
                  description: 'Whether to rebuild entire index (true) or update incrementally (false)',
                  default: false,
                },
              },
            },
          },
          {
            name: 'cancel_index_generation',
            description: 'Cancel the currently running index generation/rebuild operation. The operation will stop at the next safe checkpoint.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'index_status',
            description: 'Get current index status, statistics and embedding model information',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'reinitialize_schema',
            description: '⚠️ DESTRUCTIVE: Delete all embeddings for THIS WORKSPACE ONLY. Other workspaces are not affected. Use this to clean up workspace data or recover from indexing errors. After reinitialization, you must rebuild the index. Note: To switch embedding models, simply use reload_config and rebuild_index - no need to reinitialize.',
            inputSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  description: 'Must be set to true to confirm deletion of all embeddings for this workspace',
                },
              },
              required: ['confirm'],
            },
          },
          {
            name: 'get_template_schema',
            description: 'Get the schema (variable definitions) for a report template. Call this BEFORE create_rag_report to understand what variables the template requires. If template parameter is omitted, returns the workspace default template schema (configured via Console). This enables Claude Code to structure the report data according to the template format.',
            inputSchema: {
              type: 'object',
              properties: {
                template: {
                  type: 'string',
                  description: 'Template name (optional). If omitted, uses workspace default template from settings. Available templates: basic, paper, bullet_points',
                },
              },
            },
          },
          {
            name: 'open_index_manager',
            description: 'Open the Index Manager console in browser. The Index Manager runs as an independent process and provides real-time progress monitoring, index management, and project statistics. It remains active even when MCP server processes are terminated.',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'list_index_managers',
            description: 'List all running Index Manager processes across all workspaces',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'stop_index_manager',
            description: 'Stop a specific Index Manager process',
            inputSchema: {
              type: 'object',
              properties: {
                workspace_id: {
                  type: 'string',
                  description: 'Workspace ID of the Index Manager to stop'
                }
              },
              required: ['workspace_id']
            }
          },
          {
            name: 'reload_config',
            description: 'Reload configuration from .env file and reinitialize RAG engine without restarting MCP server. Use this after editing .env to apply configuration changes.',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
        ],
      }
    })

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const requestTime = new Date().toISOString()
      console.error(`[MCP Server] Tool call received: ${request.params.name} at ${requestTime}`)

      try {
        // Index Manager tools don't require RAG engine
        if (request.params.name === 'open_index_manager') {
          const result = await this.handleOpenIndexManager()
          console.error(`[MCP Server] Tool call completed: ${request.params.name}`)
          return result
        }
        if (request.params.name === 'list_index_managers') {
          const result = await this.handleListIndexManagers()
          console.error(`[MCP Server] Tool call completed: ${request.params.name}`)
          return result
        }
        if (request.params.name === 'stop_index_manager') {
          const result = await this.handleStopIndexManager(request.params.arguments as any)
          console.error(`[MCP Server] Tool call completed: ${request.params.name}`)
          return result
        }
        if (request.params.name === 'reload_config') {
          const result = await this.handleReloadConfig()
          console.error(`[MCP Server] Tool call completed: ${request.params.name}`)
          return result
        }

        // Ensure RAG engine is initialized for other tools
        if (!this.ragEngine) {
          try {
            await this.initializeRAGEngine()
          } catch (error: any) {
            const errorMessage = error?.message || String(error)
            if (errorMessage.includes('No embedding provider configuration found')) {
              return {
                content: [
                  {
                    type: 'text',
                    text: [
                      '❌ RAG tools are not available: Embedding provider not configured',
                      '',
                      '**Required Configuration:**',
                      '',
                      'Set one of the following in your `.env` file:',
                      '',
                      '**For OpenAI:**',
                      '```',
                      'OPENAI_API_KEY=sk-your-api-key',
                      '```',
                      '',
                      '**For Ollama (local):**',
                      '```',
                      'OLLAMA_BASE_URL=http://localhost:11434/v1',
                      'EMBEDDING_MODEL=nomic-embed-text',
                      '```',
                      '',
                      '**For OpenAI-compatible APIs:**',
                      '```',
                      'OPENAI_COMPATIBLE_API_KEY=your-api-key',
                      'OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint.com/v1',
                      'EMBEDDING_MODEL=your-model-name',
                      '```',
                      '',
                      '**Also required:**',
                      '```',
                      'DATABASE_URL=postgresql://user:pass@localhost:5432/dbname',
                      '```',
                      '',
                      'See README.md for detailed instructions.',
                    ].join('\n'),
                  },
                ],
                isError: true,
              }
            } else {
              throw error // Re-throw other errors
            }
          }
        }

        let result
        switch (request.params.name) {
          case 'search_knowledge':
            result = await this.handleSearchKnowledge(request.params.arguments as any)
            break

          case 'get_search_results':
            result = await this.handleGetSearchResults(request.params.arguments as any)
            break

          case 'generate_report':
            result = await this.handleGenerateReport(request.params.arguments as any)
            break

          case 'create_rag_report':
            result = await this.handleCreateRagReport(request.params.arguments as any)
            break

          case 'list_search_results':
            result = await this.handleListSearchResults()
            break

          case 'rebuild_index':
            result = await this.handleRebuildIndex(request.params.arguments as any)
            break

          case 'cancel_index_generation':
            result = await this.handleCancelIndexGeneration()
            break

          case 'index_status':
            result = await this.handleIndexStatus()
            break

          case 'reinitialize_schema':
            result = await this.handleReinitializeSchema(request.params.arguments as any)
            break

          case 'get_template_schema':
            result = await this.handleGetTemplateSchema(request.params.arguments as any)
            break

          default:
            throw new Error(`Unknown tool: ${request.params.name}`)
        }

        console.error(`[MCP Server] Tool call completed: ${request.params.name}`)
        return result
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error(`[MCP Server] Tool error [${request.params.name}]:`, errorMessage)
        if (error instanceof Error && error.stack) {
          console.error(`[MCP Server] Error stack:`, error.stack)
        }

        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${request.params.name}: ${errorMessage}`,
            },
          ],
          isError: true,
        }
      }
    })

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async (_request: ListResourcesRequest) => {
      return await this.handleListResources()
    })

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
      return await this.handleReadResource(request.params.uri)
    })
  }

  private async initializeRAGEngine(): Promise<void> {
    const workspacePath = process.cwd()
    console.error(`Initializing RAG engine for workspace: ${workspacePath}`)

    this.ragEngine = await createRAGEngineFromConfig(workspacePath)

    // Pass config to template engine
    const config = this.ragEngine.getConfig()
    this.templateEngine.setConfig(config)

    // Initialize BrowserFlag and ProgressServerFlag with workspace ID to support multiple workspaces
    const workspaceId = this.ragEngine.getVectorManager().getWorkspaceId()
    this.browserFlag = new BrowserFlag(workspaceId)
    this.progressServerFlag = new ProgressServerFlag(workspaceId)

    // Load maxSessionResults from environment variable and reinitialize SessionManager if needed
    const maxSessionResults = process.env.RAG_MAX_SESSION_RESULTS
      ? parseInt(process.env.RAG_MAX_SESSION_RESULTS)
      : 10
    if (maxSessionResults !== this.sessionManager.maxResults) {
      console.error(`Updating SessionManager maxResults from ${this.sessionManager.maxResults} to ${maxSessionResults}`)
      this.sessionManager = new SessionManagerImpl(maxSessionResults)
    }

    console.error('RAG engine initialized successfully')
  }

  private async handleSearchKnowledge(args: VaultSearchParams) {
    if (!this.ragEngine) throw new Error('RAG engine not initialized')

    console.error(`Searching for: "${sanitizeQuery(args.query)}" [query length: ${args.query.length}]`)

    const progressLog: string[] = []

    // search_knowledge always retrieves 20 results (for caching)
    const searchArgs = { ...args, limit: 20 }

    const results = await this.ragEngine.searchWithAutoUpdate(
      searchArgs,
      (progress: QueryProgressState) => {
        switch (progress.type) {
          case 'indexing':
            progressLog.push(
              `Indexing: ${progress.indexProgress.completedChunks}/${progress.indexProgress.totalChunks} chunks (${progress.indexProgress.totalFiles} files)`
            )
            if (progress.indexProgress.waitingForRateLimit) {
              progressLog.push('⏳ Rate limit hit, waiting...')
            }
            break
          case 'querying':
            progressLog.push('🔍 Performing semantic search...')
            break
          case 'querying-done':
            progressLog.push(`✅ Found ${progress.queryResult.length} results`)
            break
        }
      }
    )

    // Store results in session
    const sessionId = this.sessionManager.addSearchResult(args.query, results)

    return {
      content: [
        {
          type: 'text',
          text: [
            `# Search Completed: "${args.query}"`,
            '',
            `✅ Found ${results.length} relevant documents`,
            `**Session ID**: \`${sessionId}\``,
            '',
            '## Top 5 Results:',
            ...results.slice(0, 5).map((result, index) =>
              `${index + 1}. **${result.path}** - ${(result.similarity * 100).toFixed(1)}% match`
            ),
            '',
            '---',
            '',
            '🔄 **Next Steps (DO NOT STOP HERE)**',
            '',
            '1. Call **get_search_results** to retrieve full chunk content',
            '2. Analyze the content',
            '3. **MUST call create_rag_report** to create the final report file',
            '',
            '```json',
            JSON.stringify({ session_id: sessionId }, null, 2),
            '```'
          ].join('\n'),
        },
      ],
    }
  }

  private async handleGetSearchResults(args: any) {
    // Accept session_id (singular) or session_ids (plural)
    let sessionIds: string[]

    if (args.session_ids && Array.isArray(args.session_ids)) {
      sessionIds = args.session_ids
    } else if (args.session_id || args.sessionId) {
      sessionIds = [args.session_id || args.sessionId]
    } else {
      throw new Error('session_id or session_ids is required')
    }

    // Validate all session IDs
    for (const sessionId of sessionIds) {
      if (!sessionId || typeof sessionId !== 'string') {
        throw new Error(`Invalid session_id: ${sessionId}`)
      }
    }

    const config = this.ragEngine?.getConfig()
    const limitPerSession = args.limit || config?.search?.maxChunksPerQuery || 5

    // Multi-session support: retrieve results from each session
    if (sessionIds.length > 1) {
      // Multiple sessions case
      const { sessions, results } = this.sessionManager.getResultsBySessionIds(sessionIds)

      // Validate at least one valid session
      if (sessions.length === 0) {
        const availableSessions = this.sessionManager.listSearchResults().map(s => s.id).join(', ')
        throw new Error(
          `No valid sessions found in: ${sessionIds.join(', ')}. Available: ${availableSessions || 'none'}`
        )
      }

      // Apply limit per session and format results
      const formattedResults: any[] = []
      let globalIndex = 0

      for (const session of sessions) {
        const sessionResult = this.sessionManager.getSearchResult(session.sessionId)
        if (!sessionResult) continue

        const sessionResults = sessionResult.results.slice(0, limitPerSession)

        for (const result of sessionResults) {
          formattedResults.push({
            id: `multi_${globalIndex++}`,
            session_id: session.sessionId,
            file_path: result.path,
            start_line: result.metadata.startLine,
            end_line: result.metadata.endLine,
            content: result.content,
            similarity: result.similarity,
            file_uri: result.fileUri || `file://${resolve(result.path)}`
          })
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sessions,
            total_results: formattedResults.length,
            results: formattedResults
          }, null, 2)
        }]
      }
    } else {
      // Single session case (backward compatibility)
      const sessionId = sessionIds[0]
      const searchResult = this.sessionManager.getSearchResult(sessionId)
      
      if (!searchResult) {
        const availableSessions = this.sessionManager.listSearchResults().map(s => s.id).join(', ')
        throw new Error(
          `Session not found: ${sessionId}. Available sessions: ${availableSessions || 'none'}`
        )
      }

      // Apply limit and format results
      const actualLimit = Math.min(limitPerSession, searchResult.results.length)
      const results = searchResult.results.slice(0, actualLimit).map((result, idx) => ({
        id: `${sessionId}_${idx}`,
        file_path: result.path,
        start_line: result.metadata.startLine,
        end_line: result.metadata.endLine,
        content: result.content,
        similarity: result.similarity,
        file_uri: result.fileUri || `file://${resolve(result.path)}`
      }))

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: searchResult.query,
            total_results: searchResult.results.length,
            returned_results: results.length,
            results
          }, null, 2)
        }]
      }
    }
  }

  private async handleGenerateReport(args: any) {
    // Validate required parameters
    const sessionId = args.session_id || args.sessionId
    const overallSummary = args.overall_summary || args.overallSummary
    const sections = args.sections
    const template = args.template || 'basic'
    const outputDir = args.output_dir || args.outputDir || process.env.RAG_REPORT_OUTPUT_DIR || './rag-reports'
    const fileName = args.file_name || args.fileName

    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('session_id is required and must be a string')
    }
    if (!overallSummary || typeof overallSummary !== 'string') {
      throw new Error('overall_summary is required and must be a string')
    }
    if (!sections || !Array.isArray(sections)) {
      throw new Error('sections must be a non-empty array')
    }
    if (sections.length === 0) {
      throw new Error('sections array must contain at least one item')
    }

    // Validate sections structure
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      if (!section.file_path && !section.filePath) {
        throw new Error(`sections[${i}]: file_path is required`)
      }
      if (!section.summary) {
        throw new Error(`sections[${i}]: summary is required`)
      }
      if (!section.quote) {
        throw new Error(`sections[${i}]: quote is required`)
      }
    }

    // Verify session exists
    const searchResult = this.sessionManager.getSearchResult(sessionId)
    if (!searchResult) {
      const availableSessions = this.sessionManager.listSearchResults().map(s => s.id).join(', ')
      throw new Error(
        `Session not found: ${sessionId}. Available sessions: ${availableSessions || 'none'}`
      )
    }

    // Convert to ReportSection format
    const reportSections = sections.map((section: any) => ({
      filePath: section.file_path || section.filePath,
      summary: section.summary,
      quote: section.quote,
      startLine: section.start_line || section.startLine,
      endLine: section.end_line || section.endLine
    }))

    // Generate report
    const { filePath, content } = await this.templateEngine.generateReport(
      searchResult.query,
      overallSummary,
      reportSections,
      {
        template,
        outputDir,
        fileName
      }
    )

    const absolutePath = filePath.startsWith('/') ? filePath : resolve(filePath)
    const normalizedPath = absolutePath.replace(/\\/g, '/')
    const fileUri = `file://${normalizedPath}`

    // URL-encoded URI (supports non-ASCII characters)
    const pathParts = normalizedPath.split('/')
    const encodedParts = pathParts.map(part => encodeURIComponent(part))
    const encodedFileUri = `file://${encodedParts.join('/')}`

    return {
      content: [{
        type: 'text',
        text: [
          '# Report Generated Successfully',
          '',
          `**Query**: ${searchResult.query}`,
          `**Sections**: ${sections.length} items`,
          '',
          `📄 **Report File**: ${absolutePath}`,
          '',
          '## Preview:',
          '```markdown',
          content.substring(0, 500) + (content.length > 500 ? '...' : ''),
          '```'
        ].join('\n')
      }]
    }
  }

  private async handleCreateRagReport(args: any) {
    // V2 mode only - Legacy mode has been removed
    // If variables are not provided, show error with migration guide
    if (!args.variables) {
      return {
        content: [{
          type: 'text',
          text: [
            '# ⚠️ Error: Legacy Mode Removed',
            '',
            'The legacy mode has been removed. Please use V2 template-driven mode.',
            '',
            '## Migration Guide:',
            '',
            '### Step 1: Get Template Schema',
            'Call `get_template_schema` to see available templates and required variables:',
            '```json',
            '{ "template": "basic" }',
            '```',
            '',
            '### Step 2: Call create_rag_report with V2 Format',
            '```json',
            '{',
            '  "template": "basic",',
            '  "variables": {',
            '    "query": "Your search query",',
            '    "generated_at": "2025-11-12 14:30:00",',
            '    "overall_summary": "Summary of findings...",',
            '    "sections": [',
            '      {',
            '        "file_name_with_line": "example.ts:10-20",',
            '        "file_uri": "file:///path/to/example.ts#L10",',
            '        "section_summary": "This section shows...",',
            '        "section_quote": "code snippet here..."',
            '      }',
            '    ]',
            '  }',
            '}',
            '```',
            '',
            '### Available Templates:',
            '- `basic`: Standard report format',
            '- `paper`: Academic paper format',
            '- `bullet_points`: Concise bullet point format'
          ].join('\n')
        }],
        isError: true
      }
    }

    return await this.handleGenerateAnswerV2(args)
  }

  private async handleGenerateAnswerV2(args: any) {
    const variables = args.variables
    const outputDir = args.output_dir || args.outputDir
    const asciiFileName = args.ascii_filename || args.asciiFilename
    const fileName = asciiFileName || args.file_name || args.fileName
    // Load default template from environment variable if template is not specified
    const template = args.template || process.env.RAG_DEFAULT_TEMPLATE || 'basic'
    const resultIds = args.result_ids || args.resultIds

    if (!variables || typeof variables !== 'object') {
      throw new Error('variables parameter is required and must be an object')
    }

    console.error(`Generating answer (V2) with template: ${template}`)

    // Validation: Get template metadata and check required variables
    try {
      const metadata = await this.templateEngine.getTemplateMetadata(template)
      const missingVariables: string[] = []

      for (const [varName, varDef] of Object.entries(metadata.variables)) {
        if (varDef.required && !(varName in variables)) {
          missingVariables.push(varName)
        }
      }

      if (missingVariables.length > 0) {
        return {
          content: [{
            type: 'text',
            text: [
              '# ⚠️ Error: Missing Required Variables',
              '',
              `**Template**: \`${template}\``,
              '',
              `**Missing variables**: ${missingVariables.map(v => `\`${v}\``).join(', ')}`,
              '',
              '## Template Schema:',
              '```json',
              JSON.stringify(metadata, null, 2),
              '```',
              '',
              '## 💡 Solution:',
              '',
              '1. Review the schema above to understand required variables',
              '2. Add the missing variables to your request',
              '3. Call `create_rag_report` again with complete variables',
              '',
              '**Example:**',
              '```json',
              JSON.stringify({
                template: template,
                variables: metadata.example || { ...variables, ...Object.fromEntries(missingVariables.map(v => [v, '<ADD VALUE>'])) }
              }, null, 2),
              '```'
            ].join('\n')
          }],
          isError: true
        }
      }
    } catch (error) {
      console.warn(`Could not validate variables for template ${template}:`, error)
      // If metadata is unavailable, continue with a warning
    }

    // Determine output directory
    const resolvedOutputDir = outputDir || process.env.RAG_REPORT_OUTPUT_DIR || './rag-reports'

    // Convert file:// URIs to relative paths
    let processedVariables: Record<string, any>
    try {
      processedVariables = this.convertFileUrisToRelativePaths(variables, resolvedOutputDir)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[handleGenerateAnswerV2] Error converting file URIs to relative paths:', errorMessage)
      throw new Error(`Failed to convert file URIs to relative paths: ${errorMessage}`)
    }

    // Generate report using new V2 method
    let filePath: string
    let content: string
    try {
      const result = await this.templateEngine.generateAnswerV2({
        template,
        variables: processedVariables,
        resultIds,
        outputDir,
        fileName
      })
      filePath = result.filePath
      content = result.content
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined
      console.error('[handleGenerateAnswerV2] Error generating report:', errorMessage)
      if (errorStack) {
        console.error('[handleGenerateAnswerV2] Stack trace:', errorStack)
      }
      throw new Error(`Failed to generate report: ${errorMessage}`)
    }

    // Extract filename only
    const fileNameOnly = filePath.split('/').pop() || 'report.md'

    // Create absolute path
    const absolutePath = filePath.replace(/\\/g, '/')

    return {
      content: [{
        type: 'text',
        text: [
          '# Report Generated Successfully',
          '',
          `**Template**: ${template}`,
          '',
          `🔗 **Link**: [${fileNameOnly}](${absolutePath})`,
          '',
          '## Preview:',
          '```markdown',
          content.substring(0, 500) + (content.length > 500 ? '...' : ''),
          '```'
        ].join('\n')
      }]
    }
  }

  private convertFileUrisToRelativePaths(variables: Record<string, any>, outputDir: string, visited = new WeakSet()): Record<string, any> {
    // Recursively find and convert file_uri fields from file:// URLs to relative paths
    const processed: Record<string, any> = {}

    for (const [key, value] of Object.entries(variables)) {
      if (key === 'file_uri' && typeof value === 'string') {
        // Convert file:// URI to relative path
        processed[key] = this.convertFileUriToRelativePath(value, outputDir)
      } else if (Array.isArray(value)) {
        // Process each element if array
        processed[key] = value.map(item => {
          if (typeof item === 'object' && item !== null) {
            // Check for circular references
            if (visited.has(item)) {
              // Skip circular reference silently
              return item
            }
            visited.add(item)
            return this.convertFileUrisToRelativePaths(item, outputDir, visited)
          }
          return item
        })
      } else if (typeof value === 'object' && value !== null) {
        // Check for circular references
        if (visited.has(value)) {
          // Skip circular reference silently
          processed[key] = value
        } else {
          // Process recursively if object
          visited.add(value)
          processed[key] = this.convertFileUrisToRelativePaths(value, outputDir, visited)
        }
      } else {
        processed[key] = value
      }
    }

    return processed
  }

  private processFileUris(variables: Record<string, any>, visited = new WeakSet()): Record<string, any> {
    // Recursively find and properly encode file_uri fields
    const processed: Record<string, any> = {}

    for (const [key, value] of Object.entries(variables)) {
      if (key === 'file_uri' && typeof value === 'string') {
        // Properly encode file_uri
        // file:///path/to/file name.txt → file:///path/to/file%20name.txt
        processed[key] = this.encodeFileUri(value)
      } else if (Array.isArray(value)) {
        // Process each element if array
        processed[key] = value.map(item => {
          if (typeof item === 'object' && item !== null) {
            // Check for circular references
            if (visited.has(item)) {
              // Skip circular reference silently
              return item
            }
            visited.add(item)
            return this.processFileUris(item, visited)
          }
          return item
        })
      } else if (typeof value === 'object' && value !== null) {
        // Check for circular references
        if (visited.has(value)) {
          // Skip circular reference silently
          processed[key] = value
        } else {
          // Process recursively if object
          visited.add(value)
          processed[key] = this.processFileUris(value, visited)
        }
      } else {
        processed[key] = value
      }
    }

    return processed
  }

  private convertFileUriToRelativePath(uri: string, outputDir: string): string {
    // Convert file:// URI to relative path from outputDir
    if (!uri.startsWith('file://')) {
      // Already a relative path or not a file URI
      return uri
    }

    // Separate file:// and anchor (#)
    const hashIndex = uri.indexOf('#')
    const baseUri = hashIndex !== -1 ? uri.substring(0, hashIndex) : uri
    const anchor = hashIndex !== -1 ? uri.substring(hashIndex) : ''

    // Remove file:// and get absolute path
    const absolutePath = baseUri.substring(7) // 'file://'.length === 7

    // Decode URI components (handle %20, etc.)
    const decodedPath = decodeURIComponent(absolutePath)

    // Calculate relative path from output directory
    const resolvedOutputDir = resolve(outputDir)
    const relativePath = relative(resolvedOutputDir, decodedPath)

    // Ensure forward slashes for consistency (even on Windows)
    const normalizedPath = relativePath.replace(/\\/g, '/')

    // Return relative path with anchor
    return normalizedPath + anchor
  }

  private encodeFileUri(uri: string): string {
    // Properly encode file:// protocol URIs
    if (!uri.startsWith('file://')) {
      return uri
    }

    // Separate file:// and anchor (#)
    const hashIndex = uri.indexOf('#')
    const baseUri = hashIndex !== -1 ? uri.substring(0, hashIndex) : uri
    const anchor = hashIndex !== -1 ? uri.substring(hashIndex) : ''

    // Remove file:// and get path part
    const pathPart = baseUri.substring(7) // 'file://'.length === 7

    // Split path and encode each segment
    const segments = pathPart.split('/')
    const encodedSegments = segments.map(segment => {
      // If already encoded, keep as is
      if (segment.includes('%')) {
        return segment
      }
      // Encode (non-ASCII characters, spaces, etc.)
      return encodeURIComponent(segment)
    })

    return 'file://' + encodedSegments.join('/') + anchor
  }

  private async handleListSearchResults() {
    const searchResults = this.sessionManager.listSearchResults()

    if (searchResults.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No search results cached in current session. Use `search_knowledge` to perform searches.',
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: [
            `# Cached Search Results (${searchResults.length}/${this.sessionManager.maxResults})`,
            '',
            ...searchResults.map((session) => [
              `## ${session.id}`,
              `- **Query**: "${session.query}"`,
              `- **Results**: ${session.results.length} items`,
              `- **Timestamp**: ${session.timestamp.toLocaleString('ja-JP')}`,
              `- **Average Similarity**: ${(session.results.reduce((sum, r) => sum + r.similarity, 0) / session.results.length * 100).toFixed(1)}%`,
              ''
            ].join('\n')),
            '',
            '## Usage:',
            `Use these IDs with \`create_rag_report\` to create reports:`,
            '```json',
            JSON.stringify({ result_ids: searchResults.map(s => s.id) }, null, 2),
            '```',
          ].join('\n'),
        },
      ],
    }
  }

  private async handleRebuildIndex(args: RebuildIndexParams) {
    if (!this.ragEngine) throw new Error('RAG engine not initialized')

    // Capture ragEngine in local variable for TypeScript null-safety in closure
    const ragEngine = this.ragEngine

    // Use runExclusive with tryAcquire-wrapped mutex
    // This ensures only one indexing operation can run at a time
    // If already locked, an error is thrown immediately (no waiting)
    try {
      return await this.indexMutex.runExclusive(async () => {
        console.error('[handleRebuildIndex] Mutex acquired, starting index operation')

        // Extract parameters
        const { reindex_all = false, reindexAll = false } = args
        const shouldReindexAll = reindex_all || reindexAll
        console.error(`${shouldReindexAll ? 'Full' : 'Incremental'} index rebuild started`)

        // Reset cancellation controller before starting
        console.error('[handleRebuildIndex] Resetting cancellation controller')
        this.indexCancellationController.reset()
        console.error('[handleRebuildIndex] isCancelled after reset:', this.indexCancellationController.isCancelled)

        const progressLog: string[] = []
        let startTime = Date.now()
        let lastLoggedChunk = 0
        let wasCancelled = false

        try {
          await ragEngine.updateVaultIndex(
            { reindexAll: shouldReindexAll },
            (progress: QueryProgressState) => {
              if (progress.type === 'indexing') {
                const { completedChunks, totalChunks, totalFiles, currentFileName, completedFiles, waitingForRateLimit, isCancelled } = progress.indexProgress

                if (isCancelled) {
                  wasCancelled = true
                  console.error('[handleRebuildIndex] Progress callback detected cancellation at', completedChunks, '/', totalChunks)
                  const percentage = Math.floor((completedChunks / totalChunks) * 100)
                  progressLog.push(`🚫 Indexing cancelled at ${completedChunks}/${totalChunks} chunks (${percentage}%)`)
                } else if (waitingForRateLimit) {
                  progressLog.push('⏳ API rate limit reached, waiting...')
                } else if (completedChunks === totalChunks) {
                  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
                  progressLog.push(`✅ Indexing complete: ${totalChunks} chunks from ${totalFiles} files (${duration}s)`)
                } else if (completedChunks > 0 && completedChunks - lastLoggedChunk >= Math.max(1, Math.floor(totalChunks / 20))) {
                  // Log progress every ~5% or at minimum every chunk if total is small
                  const percentage = Math.floor((completedChunks / totalChunks) * 100)
                  const fileProgress = completedFiles !== undefined ? ` [${completedFiles}/${totalFiles} files]` : ''
                  const currentFile = currentFileName ? ` - ${currentFileName}` : ''
                  progressLog.push(`📊 Progress: ${completedChunks}/${totalChunks} chunks (${percentage}%)${fileProgress}${currentFile}`)
                  lastLoggedChunk = completedChunks
                }
              }
            },
            this.indexCancellationController
          )

          const status = await ragEngine.getIndexStatus()

          if (wasCancelled) {
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `## Index ${shouldReindexAll ? 'Rebuild' : 'Update'} Cancelled`,
                    '',
                    '### Progress:',
                    ...progressLog,
                    '',
                    '### Current Status:',
                    `- **Total Files Indexed**: ${status.indexedFiles}`,
                    `- **Embedding Model**: ${status.embeddingModel}`,
                    `- **Database Stats**: ${status.stats.map(s => `${s.model}: ${s.rowCount} vectors`).join(', ')}`,
                    '',
                    '⚠️ Index generation was cancelled. The index contains partial data.',
                    '💡 Run `rebuild_index` again to complete the indexing process.',
                  ].join('\n'),
                },
              ],
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: [
                  `## Index ${shouldReindexAll ? 'Rebuild' : 'Update'} Complete`,
                  '',
                  '### Progress:',
                  ...progressLog,
                  '',
                  '### Final Status:',
                  `- **Total Files Indexed**: ${status.indexedFiles}`,
                  `- **Embedding Model**: ${status.embeddingModel}`,
                  `- **Database Stats**: ${status.stats.map(s => `${s.model}: ${s.rowCount} vectors`).join(', ')}`,
                  '',
                  '✅ Index is ready for searches',
                ].join('\n'),
              },
            ],
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error('[handleRebuildIndex] Error during indexing:', errorMessage)
          return {
            content: [
              {
                type: 'text',
                text: [
                  `## Index ${shouldReindexAll ? 'Rebuild' : 'Update'} Failed`,
                  '',
                  '### Progress:',
                  ...progressLog,
                  '',
                  `### Error: ${errorMessage}`,
                  '',
                  '💡 **Troubleshooting:**',
                  '- Check your API key is set correctly',
                  '- Verify network connectivity',
                  '- Ensure workspace has readable files',
                  '- Try reducing chunk size or batch size',
                ].join('\n'),
              },
            ],
            isError: true,
          }
        }
        // Mutex is automatically released when runExclusive completes
        // No manual release() needed
      })
    } catch (error) {
      // Catch error from tryAcquire (when mutex is already locked)
      console.error('[handleRebuildIndex] Failed to acquire mutex (operation already in progress)')
      return {
        content: [
          {
            type: 'text',
            text: '⚠️ Index operation already in progress. Please wait for the current operation to complete or cancel it first.',
          },
        ],
        isError: true,
      }
    }
  }

  private async handleCancelIndexGeneration() {
    console.error('[handleCancelIndexGeneration] Cancellation requested for index generation')
    console.error('[handleCancelIndexGeneration] Current isCancelled state:', this.indexCancellationController.isCancelled)
    this.indexCancellationController.cancel()
    console.error('[handleCancelIndexGeneration] After cancel() - isCancelled state:', this.indexCancellationController.isCancelled)

    return {
      content: [
        {
          type: 'text',
          text: [
            '## Index Generation Cancellation Requested',
            '',
            '🚫 Cancellation signal sent to the indexing process.',
            '',
            'The operation will stop at the next safe checkpoint (after the current batch completes).',
            '',
            '⏳ Please wait a moment for the process to stop gracefully...',
          ].join('\n'),
        },
      ],
    }
  }

  private async handleIndexStatus() {
    if (!this.ragEngine) throw new Error('RAG engine not initialized')

    const status = await this.ragEngine.getIndexStatus()
    const config = this.ragEngine.getConfig()
    const modelInfo = this.ragEngine.getEmbeddingModelInfo()

    return {
      content: [
        {
          type: 'text',
          text: [
            '# RAG Index Status',
            '',
            '## Index Information',
            `- **Status**: ${status.isInitialized ? '✅ Initialized' : '❌ Not Initialized'}`,
            `- **Total Files**: ${status.totalFiles}`,
            `- **Indexed Files**: ${status.indexedFiles}`,
            `- **Last Updated**: ${status.lastUpdated?.toISOString() || 'Never'}`,
            '',
            '## Embedding Model',
            `- **Model**: ${modelInfo.id}`,
            `- **Provider**: ${modelInfo.provider}`,
            `- **Dimensions**: ${modelInfo.dimension}`,
            '',
            '## Database Statistics',
            ...status.stats.map(stat =>
              `- **${stat.model}**: ${stat.rowCount.toLocaleString()} vectors (${(stat.totalDataBytes / 1024 / 1024).toFixed(2)} MB)`
            ),
            '',
            '## Configuration',
            `- **Chunk Size**: ${config.chunking.chunkSize}`,
            `- **Chunk Overlap**: ${config.chunking.chunkOverlap}`,
            `- **Min Similarity**: ${config.search.minSimilarity}`,
            `- **Max Results**: ${config.search.maxResults}`,
            '',
            '### Include Patterns:',
            ...config.indexing.includePatterns.map(p => `- \`${p}\``),
            '',
            '### Exclude Patterns:',
            ...config.indexing.excludePatterns.map(p => `- \`${p}\``),
          ].join('\n'),
        },
      ],
    }
  }

  private async handleReinitializeSchema(args: any) {
    if (!this.ragEngine) throw new Error('RAG engine not initialized')

    // Validate confirmation
    if (args.confirm !== true) {
      return {
        content: [
          {
            type: 'text',
            text: [
              '⚠️  Schema reinitialization requires confirmation',
              '',
              '**Warning**: This operation will DELETE ALL existing embeddings for THIS WORKSPACE.',
              '**Other workspaces are NOT affected.**',
              '',
              '**Note**: To switch embedding models, you typically do NOT need this tool.',
              'Instead, use `reload_config` to load the new model, then `rebuild_index`.',
              '',
              'Use this tool only if you need to:',
              '- Clean up workspace data completely',
              '- Recover from indexing errors',
              '- Start fresh with the same workspace',
              '',
              'To proceed, call this tool again with:',
              '```json',
              '{',
              '  "confirm": true',
              '}',
              '```',
            ].join('\n'),
          },
        ],
      }
    }

    const vectorManager = this.ragEngine.getVectorManager()
    const embeddingModel = this.ragEngine.getEmbeddingModel()
    const embeddingDimension = embeddingModel.dimension
    const workspaceId = vectorManager.getWorkspaceId()

    try {
      // Reinitialize embeddings for this workspace only
      await vectorManager.reinitializeSchema(embeddingModel)

      return {
        content: [
          {
            type: 'text',
            text: [
              '✅ Workspace embeddings deleted successfully',
              '',
              '## Details',
              `- **Workspace**: ${workspaceId}`,
              `- **Embedding model**: ${embeddingModel.id}`,
              `- **Dimension**: vector(${embeddingDimension})`,
              `- **Scope**: This workspace only`,
              '',
              '✅ **Other workspaces are not affected**',
              '',
              '## Next Steps',
              '1. Run `rebuild_index` with `reindex_all: true` to recreate embeddings',
              '2. This will index all files in this workspace',
              '',
              '```json',
              '{',
              '  "tool": "rebuild_index",',
              '  "arguments": {',
              '    "reindex_all": true',
              '  }',
              '}',
              '```',
            ].join('\n'),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to reinitialize schema: ${errorMessage}`)
    }
  }

  private async handleGetTemplateSchema(args: any) {
    // If template is not specified, use environment variable defaultTemplate
    const templateName = args.template || process.env.RAG_DEFAULT_TEMPLATE || 'basic'

    try {
      const metadata = await this.templateEngine.getTemplateMetadata(templateName)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(metadata, null, 2)
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Get template list
      let availableTemplates: string[] = []
      try {
        const templates = await this.templateEngine.listTemplates()
        availableTemplates = templates.map(t => t.name)
      } catch {
        availableTemplates = ['basic']
      }

      return {
        content: [
          {
            type: 'text',
            text: [
              `# Error: Template Schema Not Found`,
              '',
              `Template "${templateName}" does not have metadata or does not exist.`,
              '',
              `**Available templates**: ${availableTemplates.join(', ')}`,
              '',
              `**Note**: To use the new template system, create a \`${templateName}.md.json\` file in the templates directory.`,
              '',
              `**Error details**: ${errorMessage}`
            ].join('\n')
          }
        ],
        isError: true
      }
    }
  }

  private async handleOpenIndexManager() {
    const workspacePath = process.cwd()
    const workspaceId = generateWorkspaceId(workspacePath)

    console.error(`[MCP Server] handleOpenIndexManager called`)
    console.error(`  - workspace: ${workspacePath}`)
    console.error(`  - workspaceId: ${workspaceId}`)

    const registry = new IndexManagerRegistry()

    // Check for existing Index Manager
    const existing = registry.getByWorkspace(workspaceId)

    console.error(`[MCP Server] Existing Index Manager check: ${existing ? 'FOUND' : 'NOT FOUND'}`)
    if (existing) {
      console.error(`  - PID: ${existing.pid}, Port: ${existing.port}`)
    }

    if (existing) {
      // Already running
      const url = `http://localhost:${existing.port}`
      this.openBrowser(url)

      return {
        content: [{
          type: 'text',
          text: `Index Manager already running for this workspace.\nOpening browser: ${url}\n\nPID: ${existing.pid}\nPort: ${existing.port}`
        }]
      }
    }

    // Start new instance
    const port = registry.findAvailablePort(workspaceId)

    console.error(`[MCP Server] Starting Index Manager for workspace ${workspaceId}...`)

    // Debug: Check environment variables before spawning
    console.error(`[MCP Server] Environment check before spawn:`)
    console.error(`  - OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : 'NOT SET'}`)
    console.error(`  - OPENAI_COMPATIBLE_API_KEY: ${process.env.OPENAI_COMPATIBLE_API_KEY ? 'set' : 'NOT SET'}`)
    console.error(`  - OPENAI_COMPATIBLE_BASE_URL: ${process.env.OPENAI_COMPATIBLE_BASE_URL ? 'set' : 'NOT SET'}`)
    console.error(`  - OLLAMA_BASE_URL: ${process.env.OLLAMA_BASE_URL ? 'set' : 'NOT SET'}`)
    console.error(`  - DATABASE_URL: ${process.env.DATABASE_URL ? 'set' : 'NOT SET'}`)

    const indexManagerPath = join(__dirname, 'index-manager.js')
    const child = spawn('node', [
      indexManagerPath,
      '--workspace-path', workspacePath,
      '--port', port.toString()
    ], {
      detached: true,
      stdio: 'ignore',  // Independent from parent (logs to file)
      env: process.env  // Inherit parent environment variables
    })

    child.unref()

    console.error(`[MCP Server] Index Manager started (PID: ${child.pid}, port: ${port})`)

    // Wait for server to start
    await this.waitForServer(`http://localhost:${port}`, 10000)

    // Open browser
    const url = `http://localhost:${port}`
    this.openBrowser(url)

    return {
      content: [{
        type: 'text',
        text: `Index Manager started successfully.\nOpening browser: ${url}\n\nPID: ${child.pid}\nPort: ${port}\n\nThe Index Manager runs independently and will remain active even if this MCP server process is terminated.`
      }]
    }
  }

  private async handleListIndexManagers() {
    const registry = new IndexManagerRegistry()
    const managers = registry.getAll()

    if (managers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Index Managers are currently running.'
        }]
      }
    }

    const lines = ['Running Index Managers:', '']

    for (const manager of managers) {
      lines.push(`Workspace: ${manager.workspacePath}`)
      lines.push(`  ID: ${manager.workspaceId}`)
      lines.push(`  PID: ${manager.pid}`)
      lines.push(`  Port: ${manager.port}`)
      lines.push(`  URL: http://localhost:${manager.port}`)
      lines.push(`  Started: ${manager.startTime}`)
      lines.push('')
    }

    return {
      content: [{
        type: 'text',
        text: lines.join('\n')
      }]
    }
  }

  private async handleStopIndexManager(args: { workspace_id: string }) {
    const registry = new IndexManagerRegistry()
    const manager = registry.getByWorkspace(args.workspace_id)

    if (!manager) {
      return {
        content: [{
          type: 'text',
          text: `No Index Manager found for workspace ID: ${args.workspace_id}`
        }],
        isError: true
      }
    }

    try {
      process.kill(manager.pid, 'SIGTERM')
      console.error(`[MCP Server] Sent SIGTERM to Index Manager (PID: ${manager.pid})`)

      return {
        content: [{
          type: 'text',
          text: `Index Manager stopped successfully.\nWorkspace: ${manager.workspacePath}\nPID: ${manager.pid}`
        }]
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Failed to stop Index Manager: ${error}`
        }],
        isError: true
      }
    }
  }

  private async handleReloadConfig() {
    console.error('[MCP Server] Reloading configuration from .env file')

    try {
      // Store old template setting before reload
      const oldTemplate = process.env.RAG_DEFAULT_TEMPLATE || 'basic'

      // Reload .env file
      const envPath = join(__dirname, '..', '..', '.env')
      const result = config({ path: envPath, override: true })

      if (result.error) {
        console.error('[MCP Server] Warning: No .env file found, using existing environment variables')
      } else {
        console.error('[MCP Server] .env file reloaded successfully')
      }

      // Check if template changed
      const newTemplate = process.env.RAG_DEFAULT_TEMPLATE || 'basic'
      const templateChanged = oldTemplate !== newTemplate

      // Reinitialize RAG engine with new configuration
      const oldEngine = this.ragEngine
      this.ragEngine = null

      try {
        await this.initializeRAGEngine()

        // Cleanup old engine
        if (oldEngine) {
          await oldEngine.cleanup()
        }

        // Build response message
        const messageLines = [
          '✅ Configuration reloaded successfully',
          '',
          '**Updated components:**',
          '- Environment variables (.env)',
          '- RAG engine configuration',
          '- Embedding model settings',
          '- Session manager',
        ]

        // Add template change notification if applicable
        if (templateChanged) {
          messageLines.push(`- Default template: ${oldTemplate} → ${newTemplate}`)
        }

        messageLines.push(
          '',
          '**Available template schemas (via MCP Resources):**',
          `- template://current/schema (now points to: ${newTemplate})`,
          '- template://basic/schema',
          '- template://paper/schema',
          '- template://bullet_points/schema',
          '',
          '**Note:** Running Index Managers are not affected. To apply changes to Index Managers, restart them using stop_index_manager and open_index_manager tools.',
        )

        return {
          content: [{
            type: 'text',
            text: messageLines.join('\n')
          }]
        }
      } catch (error) {
        // Restore old engine if reinitialization failed
        this.ragEngine = oldEngine
        throw error
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[MCP Server] Error reloading configuration:', errorMessage)

      return {
        content: [{
          type: 'text',
          text: [
            '❌ Failed to reload configuration',
            '',
            `**Error:** ${errorMessage}`,
            '',
            '**Troubleshooting:**',
            '- Check your .env file for syntax errors',
            '- Verify all required environment variables are set',
            '- Check console logs for detailed error messages',
          ].join('\n')
        }],
        isError: true
      }
    }
  }

  /**
   * Handle listing available template schema resources
   */
  private async handleListResources() {
    try {
      const templates = await this.templateEngine.listTemplates()
      const defaultTemplate = process.env.RAG_DEFAULT_TEMPLATE || 'basic'

      const resources = []

      // Add current/default template schema resource
      resources.push({
        uri: 'template://current/schema',
        name: `Current Template Schema (${defaultTemplate})`,
        description: `Schema for the workspace default template: ${defaultTemplate}. This always points to the template configured in RAG_DEFAULT_TEMPLATE.`,
        mimeType: 'application/json'
      })

      // Add individual template schema resources
      for (const template of templates) {
        resources.push({
          uri: `template://${template.name}/schema`,
          name: `${template.name} Template Schema`,
          description: `Schema for the '${template.name}' template: ${template.description}`,
          mimeType: 'application/json'
        })
      }

      return { resources }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[MCP Server] Error listing resources:', errorMessage)
      return { resources: [] }
    }
  }

  /**
   * Handle reading a template schema resource
   */
  private async handleReadResource(uri: string) {
    try {
      // Parse URI: template://{name}/schema
      const match = uri.match(/^template:\/\/([^/]+)\/schema$/)
      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}. Expected format: template://{name}/schema`)
      }

      let templateName = match[1]

      // Handle 'current' alias
      if (templateName === 'current') {
        templateName = process.env.RAG_DEFAULT_TEMPLATE || 'basic'
      }

      // Get template metadata
      const metadata = await this.templateEngine.getTemplateMetadata(templateName)

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(metadata, null, 2)
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[MCP Server] Error reading resource ${uri}:`, errorMessage)

      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error reading resource: ${errorMessage}`
          }
        ]
      }
    }
  }

  private async waitForServer(url: string, timeout: number): Promise<void> {
    const start = Date.now()

    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(url)
        if (response.ok) {
          return
        }
      } catch {
        // Ignore
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    throw new Error(`Server did not start within ${timeout}ms`)
  }

  async start(): Promise<void> {
    console.error(`[MCP Server] Process starting (PID: ${process.pid})`)
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('Local Knowledge RAG MCP server running on stdio')

    // Monitor stdin for closure - indicates parent process disconnected
    // This provides automatic cleanup if client fails to terminate the server
    const handleStdinClose = (eventType: string) => {
      if (this.isShuttingDown) return
      this.isShuttingDown = true

      const uptimeSeconds = Math.floor(process.uptime())
      const uptimeMinutes = Math.floor(uptimeSeconds / 60)
      const uptimeHours = Math.floor(uptimeMinutes / 60)

      console.error(`[MCP Server] stdin '${eventType}' event - parent process disconnected, shutting down...`)
      console.error(`[MCP Server] Process uptime: ${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`)
      console.error(`[MCP Server] Parent PID: ${process.ppid}`)
      console.error(`[MCP Server] Memory usage: ${JSON.stringify(process.memoryUsage())}`)

      this.stop().then(() => {
        process.exit(0)
      }).catch((error) => {
        console.error('[MCP Server] Error during shutdown:', error)
        process.exit(1)
      })
    }

    process.stdin.on('end', () => handleStdinClose('end'))
    process.stdin.on('close', () => handleStdinClose('close'))

    // Periodic health check log (every 5 minutes)
    const healthCheckInterval = setInterval(() => {
      const uptimeSeconds = Math.floor(process.uptime())
      const uptimeMinutes = Math.floor(uptimeSeconds / 60)
      const mem = process.memoryUsage()
      console.error(`[Health Check] Uptime: ${uptimeMinutes}m, Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB/${Math.round(mem.heapTotal / 1024 / 1024)}MB, PID: ${process.pid}`)
    }, 5 * 60 * 1000) // 5 minutes

    // Clear interval on shutdown
    const originalStop = this.stop.bind(this)
    this.stop = async () => {
      clearInterval(healthCheckInterval)
      return await originalStop()
    }

    // Initialize RAG engine immediately to enable progress server
    try {
      await this.initializeRAGEngine()
      console.error('RAG engine initialized')
    } catch (error: any) {
      // Check if this is a workspace_id column error
      if (error?.code === '42703' || (error?.message && error.message.includes('workspace_id'))) {
        console.error('')
        console.error('⚠️  ========================================')
        console.error('⚠️  DATABASE MIGRATION REQUIRED')
        console.error('⚠️  ========================================')
        console.error('')
        console.error('Your database schema needs to be updated to support')
        console.error('multi-workspace functionality.')
        console.error('')
        console.error('Use the reinitialize_schema tool to migrate:')
        console.error('')
        console.error('  {')
        console.error('    "tool": "reinitialize_schema",')
        console.error('    "arguments": { "confirm": true }')
        console.error('  }')
        console.error('')
        console.error('⚠️  Warning: This will delete all existing embeddings.')
        console.error('')
        console.error('⚠️  ========================================')
        console.error('')
      } else {
        // Check if this is an embedding configuration error
        const errorMessage = error?.message || String(error)
        if (errorMessage.includes('No embedding provider configuration found')) {
          console.error('')
          console.error('⚠️  ========================================')
          console.error('⚠️  EMBEDDING PROVIDER NOT CONFIGURED')
          console.error('⚠️  ========================================')
          console.error('')
          console.error('Required: Set one of the following in your .env file:')
          console.error('')
          console.error('  For OpenAI:')
          console.error('    OPENAI_API_KEY=sk-your-api-key')
          console.error('')
          console.error('  For Ollama (local):')
          console.error('    OLLAMA_BASE_URL=http://localhost:11434/v1')
          console.error('    EMBEDDING_MODEL=nomic-embed-text')
          console.error('')
          console.error('  For OpenAI-compatible APIs:')
          console.error('    OPENAI_COMPATIBLE_API_KEY=your-api-key')
          console.error('    OPENAI_COMPATIBLE_BASE_URL=https://your-endpoint.com/v1')
          console.error('    EMBEDDING_MODEL=your-model-name')
          console.error('')
          console.error('Also required:')
          console.error('    DATABASE_URL=postgresql://user:pass@localhost:5432/dbname')
          console.error('')
          console.error('See README.md for detailed configuration instructions.')
          console.error('')
          console.error('⚠️  ========================================')
          console.error('')
        } else {
          console.error('Warning: Failed to initialize RAG engine on startup:', errorMessage)
        }
      }
      console.error('MCP Server is running, but RAG tools are not available until configured.')
    }

    // Legacy ProgressServer removed - use Index Manager via open_index_manager tool instead
    console.error('[MCP Server] Legacy ProgressServer: disabled (use open_index_manager tool)')
    console.error(`  - RAG Engine initialized: ${!!this.ragEngine}`)

    // Clean up any stale Index Manager entries on startup
    try {
      const registry = new IndexManagerRegistry()
      const stats = registry.cleanupAll()
      if (stats.removed > 0) {
        console.error(`[MCP Server] Cleaned up ${stats.removed} stale Index Manager(s) on startup`)
      }
    } catch (error) {
      console.error('[MCP Server] Warning: Failed to cleanup Index Manager registry on startup:', error)
    }
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      console.error(`[MCP Server] Already shutting down (PID: ${process.pid})`)
      return
    }
    this.isShuttingDown = true

    console.error(`[MCP Server] stop() called for PID ${process.pid}`)
    console.error(`[MCP Server] Has ProgressServer: ${!!this.progressServer}`)

    if (this.progressServer) {
      console.error(`[MCP Server] Stopping ProgressServer (PID: ${process.pid})`)
      await this.progressServer.stop()
      // Unregister this process as the ProgressServer owner
      if (this.progressServerFlag) {
        console.error(`[MCP Server] Unregistering from ProgressServerFlag (PID: ${process.pid})`)
        this.progressServerFlag.unregister()
      }
    }
    // Unregister this server instance from browser flag
    // (flag file auto-deleted when last server stops)
    console.error(`[MCP Server] Clearing BrowserFlag (PID: ${process.pid})`)
    this.browserFlag.clear()
    console.error(`[MCP Server] stop() completed for PID ${process.pid}`)
  }

  private openBrowser(url: string): void {
    try {
      console.error(`[openBrowser] Starting, URL: ${url}`)

      const platform = process.platform
      console.error(`[openBrowser] Platform: ${platform}`)

      let command: string
      let args: string[]

      if (platform === 'darwin') {
        command = 'open'
        args = [url]
      } else if (platform === 'win32') {
        command = 'cmd'
        args = ['/c', 'start', url]
      } else {
        // Linux/Unix
        command = 'xdg-open'
        args = [url]
      }

      console.error(`[openBrowser] Command: ${command}, Args: ${JSON.stringify(args)}`)

      const child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      console.error(`[openBrowser] spawn() returned successfully`)

      child.stdout?.on('data', (data: Buffer) => {
        console.error(`[Browser stdout] ${data}`)
      })

      child.stderr?.on('data', (data: Buffer) => {
        console.error(`[Browser stderr] ${data}`)
      })

      child.on('error', (error: Error) => {
        console.error('[Browser spawn error]', error)
      })

      child.on('exit', (code: number | null, signal: string | null) => {
        console.error(`[Browser exit] code=${code}, signal=${signal}`)
      })

      child.unref()
      console.error('[openBrowser] Completed successfully')
    } catch (error) {
      console.error('[openBrowser] Exception caught:', error)
      if (error instanceof Error) {
        console.error('[openBrowser] Error name:', error.name)
        console.error('[openBrowser] Error message:', error.message)
        console.error('[openBrowser] Error stack:', error.stack)
      }
      throw error
    }
  }
}

// Safe logging that handles broken pipes
// When stdout/stderr pipes are broken (EPIPE), logging will fail
// This wrapper prevents cascading failures
let pipeBroken = false

function safeLog(...args: any[]): void {
  if (pipeBroken) return

  try {
    console.error(...args)
  } catch (error: any) {
    // If we get EPIPE, mark pipe as broken and stop trying to log
    if (error?.code === 'EPIPE' || error?.errno === -32) {
      pipeBroken = true
    }
    // Silently ignore - we can't log if the pipe is broken
  }
}

// Check if error is EPIPE (broken pipe)
function isEPIPEError(error: any): boolean {
  return error?.code === 'EPIPE' ||
         error?.errno === -32 ||
         error?.syscall === 'write' && (error?.code === 'EPIPE' || error?.errno === -32)
}

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  safeLog(`[Signal Handler] SIGINT received by PID ${process.pid}`)
  safeLog('Shutting down Local Knowledge RAG MCP server...')
  try {
    await server.stop()
  } catch (error) {
    // Ignore errors during shutdown
  }
  safeLog(`[Signal Handler] SIGINT handler completed for PID ${process.pid}, exiting...`)
  process.exit(0)
})

process.on('SIGTERM', async () => {
  const uptimeSeconds = Math.floor(process.uptime())
  const uptimeMinutes = Math.floor(uptimeSeconds / 60)
  const uptimeHours = Math.floor(uptimeMinutes / 60)

  safeLog(`[Signal Handler] SIGTERM received by PID ${process.pid}`)
  safeLog(`[Signal Handler] Process uptime: ${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`)
  safeLog(`[Signal Handler] Parent PID: ${process.ppid}`)
  safeLog(`[Signal Handler] Memory usage: ${JSON.stringify(process.memoryUsage())}`)
  safeLog(`[Signal Handler] stdin readable: ${process.stdin.readable}, writable: ${process.stdin.writable}`)
  safeLog(`[Signal Handler] stdout readable: ${process.stdout.readable}, writable: ${process.stdout.writable}`)
  safeLog(`[Signal Handler] stderr writable: ${process.stderr.writable}`)

  safeLog('Shutting down Local Knowledge RAG MCP server...')
  try {
    await server.stop()
  } catch (error) {
    // Ignore errors during shutdown
  }
  safeLog(`[Signal Handler] SIGTERM handler completed for PID ${process.pid}, exiting...`)
  process.exit(0)
})

// Track unexpected exits
process.on('exit', (code) => {
  safeLog(`[Process] PID ${process.pid} exiting with code ${code}`)
})

// Track uncaught exceptions
process.on('uncaughtException', (error) => {
  // EPIPE errors occur when stdout/stderr pipes are closed by parent process
  // This is normal during process shutdown - exit gracefully without logging
  if (isEPIPEError(error)) {
    pipeBroken = true
    process.exit(0)
    return
  }

  // For other errors, try to log (using safe logging to prevent cascading failures)
  safeLog(`[Process] Uncaught exception in PID ${process.pid}:`, error)
  safeLog(`[Process] Stack trace:`, error.stack)

  // Exit with error code for non-EPIPE errors
  process.exit(1)
})

// Track unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  safeLog(`[Process] Unhandled promise rejection in PID ${process.pid}:`, reason)
})

// Start the server
const server = new SmartComposerRAGServer()

// Debug: Log to file (conditional)
import { appendFileSync } from 'fs'

// Load debug settings from environment variables initially
// These will be updated from workspace_settings after RAG engine initialization
let debugEnabled = process.env.RAG_DEBUG_LOG_ENABLED === 'true'
let logFile = process.env.RAG_DEBUG_LOG_PATH || '/tmp/local-knowledge-rag-mcp/debug.log'

// Store original console.error for restoration
const originalConsoleError = console.error

// Setup debug logging with dynamic configuration
// The wrapper checks debugEnabled dynamically, allowing runtime configuration updates
console.error = (...args: any[]) => {
  // Write to file if debug is enabled (checked dynamically)
  if (debugEnabled) {
    const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
    } catch (error) {
      // Ignore file write errors (e.g., permission denied)
      try {
        originalConsoleError(`Failed to write to debug log ${logFile}:`, error)
      } catch {
        // If console.error fails (EPIPE), ignore silently
      }
    }
  }

  // Always write to console
  try {
    originalConsoleError(...args)
  } catch (error: any) {
    // If console.error fails with EPIPE, mark pipe as broken
    if (error?.code === 'EPIPE' || error?.errno === -32) {
      pipeBroken = true
    }
    // Ignore - can't log if pipe is broken
  }
}

if (debugEnabled) {
  console.error(`=== MCP Server Starting (Debug logging enabled: ${logFile}) ===`)
} else {
  console.error('=== MCP Server Starting ===')
}

server.start().catch((error) => {
  safeLog('Failed to start server:', error)
  process.exit(1)
})