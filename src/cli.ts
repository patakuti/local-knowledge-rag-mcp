#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { config } from 'dotenv'

// Load .env from project root (one level up from dist/)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
config({ path: join(__dirname, '..', '.env'), quiet: true })

import { Pool } from 'pg'
import { createRAGEngineFromConfig } from './core/rag-engine.js'
import { IndexManagerRegistry } from './utils/index-manager-registry.js'
import { generateWorkspaceId } from './utils/workspace-utils.js'
import type { SearchResult, QueryProgressState } from './types/rag.types.js'

interface ParsedArgs {
  options: Record<string, string>
  positional: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const options: Record<string, string> = {}
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options[key] = args[i + 1]
        i++
      } else {
        options[key] = 'true'
      }
    } else {
      positional.push(args[i])
    }
  }

  return { options, positional }
}

/**
 * Traverse up from startPath to find the nearest ancestor directory
 * that has indexed content in the database. Returns the resolved path
 * of the first match, or throws if none is found.
 */
async function findWorkspace(startPath: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required for --find-workspace'
    )
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    let current = resolve(startPath)
    while (true) {
      const workspaceId = generateWorkspaceId(current)
      const result = await pool.query(
        'SELECT 1 FROM embeddings WHERE workspace_id = $1 LIMIT 1',
        [workspaceId]
      )
      if (result.rowCount && result.rowCount > 0) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new Error(
          `No indexed workspace found in "${startPath}" or any of its ancestor directories`
        )
      }
      current = parent
    }
  } finally {
    await pool.end()
  }
}

function printUsage(): void {
  console.log(`Usage: lkrag <command> [options]

Commands:
  search <query>       Search indexed documents
  update-index         Incrementally update the index
  rebuild-index        Rebuild the entire index from scratch
  status               Show index status

Options:
  --workspace-path <path>     Workspace path (default: current directory)
  --find-workspace            Traverse up from current directory to find an indexed workspace
  --limit <n>                 Number of search results (default: 5)
  --min-similarity <n>        Minimum similarity score 0-1 (default: 0.3)
  --format <fmt>              Output format: plain|tsv|json (default: plain)
  --quiet                     Suppress informational messages on stderr

Examples:
  lkrag search "authentication flow" --workspace-path /path/to/docs
  lkrag search "setup guide" --format tsv --limit 10 --quiet
  lkrag search "error handling" --find-workspace
  lkrag update-index --workspace-path /path/to/docs
  lkrag update-index --find-workspace
  lkrag status
`)
}

function formatResults(results: SearchResult[], format: string): string {
  if (format === 'json') {
    const data = results.map(r => ({
      path: r.path,
      line: r.metadata.startLine,
      score: r.similarity,
      content: r.content.trim(),
    }))
    return JSON.stringify(data, null, 2)
  }

  if (format === 'tsv') {
    // path\tline\tscore\tcontent  — machine-parseable for Emacs etc.
    return results
      .map(r =>
        [
          r.path,
          r.metadata.startLine,
          r.similarity.toFixed(4),
          r.content.trim().replace(/\t/g, ' ').replace(/\n/g, ' '),
        ].join('\t')
      )
      .join('\n')
  }

  // plain
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.path}:${r.metadata.startLine} (score: ${r.similarity.toFixed(3)})\n` +
        r.content.trim().slice(0, 300) +
        '\n'
    )
    .join('\n')
}

async function cmdSearch(
  workspacePath: string,
  query: string,
  options: Record<string, string>
): Promise<void> {
  const limit = parseInt(options['limit'] ?? '5', 10)
  const minSimilarity = parseFloat(options['min-similarity'] ?? '0.3')
  const format = options['format'] ?? 'plain'

  const engine = await createRAGEngineFromConfig(workspacePath)
  try {
    const results = await engine.processQuery({ query, limit, minSimilarity })
    if (results.length === 0) {
      if (format === 'json') {
        console.log('[]')
      } else {
        console.log('No results found.')
      }
    } else {
      console.log(formatResults(results, format))
    }
  } finally {
    await engine.cleanup()
  }
}

function renderProgress(progress: QueryProgressState): void {
  if (progress.type !== 'indexing') return
  const p = progress.indexProgress
  const pct = p.totalChunks > 0 ? Math.round((p.completedChunks / p.totalChunks) * 100) : 0
  const file = p.currentFileName ? ` ${p.currentFileName}` : ''
  process.stderr.write(`\r[${pct}%]${file} (${p.completedChunks}/${p.totalChunks} chunks)   `)
}

async function cmdUpdateIndex(workspacePath: string, reindexAll: boolean): Promise<void> {
  const label = reindexAll ? 'rebuild' : 'update'

  // Try running Index Manager via HTTP if already active
  const workspaceId = generateWorkspaceId(workspacePath)
  const registry = new IndexManagerRegistry()
  const info = registry.getByWorkspace(workspaceId)

  if (info) {
    try {
      const res = await fetch(`http://localhost:${info.port}/rebuild-index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reindex_all: reindexAll }),
      })
      if (res.ok) {
        console.error(`[lkrag] Triggered ${label} via Index Manager on port ${info.port}`)
        return
      }
    } catch {
      console.error('[lkrag] Index Manager not responding, running directly...')
    }
  }

  // Direct execution
  console.error(`[lkrag] Starting ${label} for workspace: ${workspacePath}`)
  const engine = await createRAGEngineFromConfig(workspacePath)
  try {
    await engine.updateVaultIndex({ reindexAll }, (progress) => {
      renderProgress(progress)
    })
    process.stderr.write('\n')
    console.log(`Index ${label} complete.`)
  } finally {
    await engine.cleanup()
  }
}

async function cmdStatus(workspacePath: string, format: string): Promise<void> {
  const engine = await createRAGEngineFromConfig(workspacePath)
  try {
    const config = engine.getConfig()
    const projectStats = await engine.getVectorManager().getProjectStatistics(
      engine.getEmbeddingModel(),
      config.indexing.includePatterns,
      config.indexing.excludePatterns
    )
    const status = await engine.getIndexStatus()

    if (format === 'json') {
      console.log(JSON.stringify({ ...status, ...projectStats }, null, 2))
    } else {
      console.log(`Initialized    : ${status.isInitialized}`)
      console.log(`Total files    : ${projectStats.totalFilesInProject}`)
      console.log(`Indexed files  : ${projectStats.indexedFiles}`)
      console.log(`Not indexed    : ${projectStats.notIndexedFiles}`)
      console.log(`Deleted files  : ${projectStats.deletedFiles}`)
      console.log(`Last updated   : ${status.lastUpdated ?? 'never'}`)
      console.log(`Model          : ${status.embeddingModel}`)
    }
  } finally {
    await engine.cleanup()
  }
}

async function main(): Promise<void> {
  const { options, positional } = parseArgs(process.argv)

  if (options['env-file']) {
    config({ path: options['env-file'], quiet: true })
  }

  const command = positional[0]
  if (!command || command === 'help' || options['help'] === 'true') {
    printUsage()
    process.exit(0)
  }

  if (options['quiet'] === 'true') {
    process.env.LKRAG_QUIET = '1'
  }

  const findWorkspaceFlag = options['find-workspace'] === 'true'
  const explicitPath = options['workspace-path']

  let workspacePath: string
  if (findWorkspaceFlag && !explicitPath) {
    workspacePath = await findWorkspace(process.cwd())
    if (process.env.LKRAG_QUIET !== '1') {
      console.error(`[lkrag] workspace: ${workspacePath}`)
    }
  } else {
    workspacePath = resolve(explicitPath ?? process.cwd())
  }

  const format = options['format'] ?? 'plain'

  try {
    switch (command) {
      case 'search': {
        const query = positional.slice(1).join(' ')
        if (!query) {
          console.error('Error: search query is required')
          process.exit(1)
        }
        await cmdSearch(workspacePath, query, options)
        break
      }
      case 'update-index':
        await cmdUpdateIndex(workspacePath, false)
        break
      case 'rebuild-index':
        await cmdUpdateIndex(workspacePath, true)
        break
      case 'status':
        await cmdStatus(workspacePath, format)
        break
      default:
        console.error(`Unknown command: ${command}`)
        printUsage()
        process.exit(1)
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
