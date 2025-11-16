#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'
import { appendFileSync, mkdirSync } from 'fs'

// Load .env file from project root (two levels up from dist/)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const envPath = join(__dirname, '..', '..', '.env')
const envResult = config({ path: envPath })

// Warn if .env file is not found (but don't fail - env vars might be set elsewhere)
if (envResult.error) {
  console.error('')
  console.error('⚠️  [Index Manager] No .env file found at:', envPath)
  console.error('⚠️  Environment variables must be set via:')
  console.error('    1. Create .env file: cp .env.example .env')
  console.error('    2. Or set them in Claude Desktop/Cline config')
  console.error('    3. Or export them in your shell')
  console.error('')
}

import { ProgressServer } from './utils/progress-server.js'
import { IndexManagerRegistry } from './utils/index-manager-registry.js'
import { createRAGEngineFromConfig } from './core/rag-engine.js'
import { generateWorkspaceId, getWorkspaceTempDir } from './utils/workspace-utils.js'
import { Mutex } from 'async-mutex'
import { CancellationController } from './types/rag.types.js'
import { TemplateEngine } from './core/template-engine.js'
import type { RebuildIndexParams } from './types/rag.types.js'

// Parse command line arguments early for file logging setup
const args = process.argv.slice(2)
let workspacePath: string | undefined
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace-path' && args[i + 1]) {
    workspacePath = args[i + 1]
    break
  }
}

// Setup file logging (always enabled for Index Manager)
let logFilePath: string | undefined
if (workspacePath) {
  const workspaceId = generateWorkspaceId(workspacePath)
  const tempDir = getWorkspaceTempDir(workspaceId)
  logFilePath = join(tempDir, 'index-manager.log')

  // Ensure directory exists
  try {
    mkdirSync(tempDir, { recursive: true })
  } catch (error) {
    // Ignore directory creation errors
  }
}

// Wrap console.error to write to both file and stderr
const originalConsoleError = console.error
console.error = (...args: any[]) => {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const timestamp = new Date().toISOString()

  // Write to file
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `${timestamp} ${message}\n`)
    } catch (error) {
      // Ignore file write errors (e.g., permission denied)
    }
  }

  // Write to stderr (for debugging, even though parent ignores it)
  try {
    originalConsoleError(...args)
  } catch (error) {
    // Ignore if stderr is closed
  }
}

async function main() {
  // Parse remaining command line arguments (workspace-path already parsed for logging)
  let port = 3456

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      i++
    }
  }

  if (!workspacePath) {
    console.error('[Index Manager] Error: --workspace-path is required')
    process.exit(1)
  }

  console.error(`[Index Manager] Starting for workspace: ${workspacePath}`)
  console.error(`[Index Manager] Port: ${port}`)
  console.error(`[Index Manager] PID: ${process.pid}`)

  // Debug: Check if environment variables are available
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY
  const hasCompatibleKey = !!process.env.OPENAI_COMPATIBLE_API_KEY
  const hasCompatibleBaseUrl = !!process.env.OPENAI_COMPATIBLE_BASE_URL
  const hasOllamaBaseUrl = !!process.env.OLLAMA_BASE_URL
  const hasDatabaseUrl = !!process.env.DATABASE_URL

  console.error(`[Index Manager] Environment check:`)
  console.error(`  - OPENAI_API_KEY: ${hasOpenAIKey ? 'set' : 'NOT SET'}`)
  console.error(`  - OPENAI_COMPATIBLE_API_KEY: ${hasCompatibleKey ? 'set' : 'NOT SET'}`)
  console.error(`  - OPENAI_COMPATIBLE_BASE_URL: ${hasCompatibleBaseUrl ? 'set' : 'NOT SET'}`)
  console.error(`  - OLLAMA_BASE_URL: ${hasOllamaBaseUrl ? 'set' : 'NOT SET'}`)
  console.error(`  - DATABASE_URL: ${hasDatabaseUrl ? 'set' : 'NOT SET'}`)

  // Initialize RAG Engine
  const ragEngine = await createRAGEngineFromConfig(workspacePath)
  console.error('[Index Manager] RAG Engine initialized')

  // Initialize Progress Server
  const progressLogger = ragEngine.getVectorManager().getProgressLogger()
  const logFilePath = progressLogger.getLogFilePath()
  const progressServer = new ProgressServer(logFilePath, port)

  // Mutex and cancellation control
  const indexMutex = new Mutex()
  const indexCancellationController: CancellationController = {
    isCancelled: false,
    cancel: function() {
      this.isCancelled = true
    },
    reset: function() {
      this.isCancelled = false
    }
  }

  // Setup handlers
  setupHandlers(progressServer, ragEngine, indexMutex, indexCancellationController, workspacePath)

  // Start server
  await progressServer.start()
  const actualPort = progressServer.getPort()
  console.error(`[Index Manager] Server started on port ${actualPort}`)

  // Register in registry
  const workspaceId = generateWorkspaceId(workspacePath)
  const registry = new IndexManagerRegistry()
  registry.register({
    workspaceId,
    workspacePath,
    pid: process.pid,
    port: actualPort,
    startTime: new Date().toISOString()
  })

  console.error(`[Index Manager] Started at http://localhost:${actualPort}`)

  // Cleanup
  const cleanup = () => {
    console.error('[Index Manager] Shutting down...')
    registry.unregister(workspaceId)
    progressServer.stop().then(() => {
      ragEngine.cleanup().then(() => {
        console.error('[Index Manager] Cleanup complete')
        process.exit(0)
      })
    })
  }

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  // Monitor idle timeout
  setupIdleTimeout(progressServer, cleanup)
}

function setupIdleTimeout(
  progressServer: ProgressServer,
  cleanup: () => void
) {
  const IDLE_TIMEOUT = 5 * 60 * 1000 // 5 minutes
  let lastActivityTime = Date.now()
  let hasActiveConnections = false

  // Monitor connections
  progressServer.onConnection(() => {
    hasActiveConnections = true
    lastActivityTime = Date.now()
  })

  progressServer.onDisconnection(() => {
    hasActiveConnections = false
  })

  // Periodic check
  setInterval(() => {
    if (!hasActiveConnections &&
        Date.now() - lastActivityTime > IDLE_TIMEOUT) {
      console.error('[Index Manager] Idle timeout, shutting down...')
      cleanup()
    }
  }, 60 * 1000) // Every 1 minute
}

function setupHandlers(
  progressServer: ProgressServer,
  ragEngine: any,
  indexMutex: Mutex,
  indexCancellationController: CancellationController,
  workspacePath: string
) {
  const vectorManager = ragEngine.getVectorManager()
  const embeddingModel = ragEngine.getEmbeddingModel()

  // Schema status handler
  progressServer.setSchemaStatusHandler(
    async () => {
      const validation = await vectorManager.validateSchemaDimension(embeddingModel.dimension)
      const config = ragEngine.getConfig()
      const projectStats = await vectorManager.getProjectStatistics(
        embeddingModel,
        config.indexing.includePatterns,
        config.indexing.excludePatterns
      )
      return {
        ...validation,
        projectStats,
        workspacePath
      }
    }
  )

  // Rebuild index handler
  progressServer.setRebuildIndexHandler(async (reindexAll: boolean) => {
    console.error('[Index Manager RebuildIndexHandler] Rebuild index called with reindexAll:', reindexAll)

    try {
      return await indexMutex.runExclusive(async () => {
        console.error('[Index Manager] Mutex acquired, starting index operation')

        const shouldReindexAll = reindexAll
        console.error(`${shouldReindexAll ? 'Full' : 'Incremental'} index rebuild started`)

        // Reset cancellation controller before starting
        indexCancellationController.reset()

        const progressLog: string[] = []
        let startTime = Date.now()
        let lastLoggedChunk = 0
        let wasCancelled = false

        const onProgress = (progress: any) => {
          if (progress.type === 'indexing') {
            const { completedChunks, totalChunks, totalFiles, currentFileName, completedFiles, waitingForRateLimit, isCancelled } = progress.indexProgress

            if (isCancelled) {
              wasCancelled = true
              console.error('[Index Manager] Progress callback detected cancellation at', completedChunks, '/', totalChunks)
              const percentage = Math.floor((completedChunks / totalChunks) * 100)
              progressLog.push(`🚫 Indexing cancelled at ${completedChunks}/${totalChunks} chunks (${percentage}%)`)
            } else if (waitingForRateLimit) {
              progressLog.push('⏳ API rate limit reached, waiting...')
            } else if (completedChunks === totalChunks) {
              const endTime = Date.now()
              const duration = ((endTime - startTime) / 1000).toFixed(1)
              progressLog.push(`✅ Finished: ${completedChunks}/${totalChunks} chunks, ${completedFiles}/${totalFiles} files (${duration}s)`)
            } else if (completedChunks - lastLoggedChunk >= 100) {
              const percentage = Math.floor((completedChunks / totalChunks) * 100)
              progressLog.push(`📊 Progress: ${completedChunks}/${totalChunks} chunks (${percentage}%), ${completedFiles}/${totalFiles} files`)
              lastLoggedChunk = completedChunks
            }
          }
        }

        try {
          await ragEngine.updateVaultIndex(
            { reindexAll: shouldReindexAll },
            onProgress,
            indexCancellationController
          )

          if (wasCancelled) {
            return {
              content: [{
                type: 'text',
                text: '🚫 Index operation cancelled.\n\n' + progressLog.join('\n')
              }],
              isError: false
            }
          }

          return {
            content: [{
              type: 'text',
              text: `✅ Index ${shouldReindexAll ? 'rebuild' : 'update'} completed successfully.\n\n` + progressLog.join('\n')
            }],
            isError: false
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error('[Index Manager] Error during indexing:', errorMessage)
          return {
            content: [{
              type: 'text',
              text: [
                `❌ Index operation failed`,
                ``,
                `Error: ${errorMessage}`,
                ``,
                `Progress log:`,
                ...progressLog
              ].join('\n')
            }],
            isError: true
          }
        }
      })
    } catch (error) {
      console.error('[Index Manager] Failed to acquire mutex (operation already in progress)')
      return {
        content: [{
          type: 'text',
          text: '⚠️ Index operation already in progress. Please wait for the current operation to complete or cancel it first.'
        }],
        isError: true
      }
    }
  })

  // Cancel handler
  progressServer.setCancelHandler(() => {
    console.error('[Index Manager CancelHandler] Cancel handler called from progress server')
    indexCancellationController.cancel()
  })

  // List templates handler
  progressServer.setListTemplatesHandler(async () => {
    const templateEngine = new TemplateEngine('./templates')
    templateEngine.setConfig(ragEngine.getConfig())
    return await templateEngine.listTemplates()
  })
}

main().catch(error => {
  console.error('[Index Manager] Fatal error:', error)
  process.exit(1)
})
