import http from 'http'
import net from 'net'
import fs from 'fs/promises'
import path from 'path'

export class ProgressServer {
  private server: http.Server | null = null
  private port: number
  private actualPort: number = 0
  private logFilePath: string
  private getSchemaStatusFn?: () => Promise<any>
  private rebuildIndexFn?: (reindexAll: boolean) => Promise<any>
  private cancelIndexingFn?: () => void
  private listTemplatesFn?: () => Promise<any>
  // Connection monitoring
  private activeConnections: Set<net.Socket> = new Set()
  private connectionCallbacks: Array<() => void> = []
  private disconnectionCallbacks: Array<() => void> = []

  constructor(logFilePath: string, port: number = 3456) {
    this.logFilePath = logFilePath
    this.port = port
  }

  /**
   * Find an available port starting from the preferred port
   */
  private async findAvailablePort(startPort: number, maxAttempts: number = 50): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i
      if (await this.isPortAvailable(port)) {
        return port
      }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`)
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const testServer = http.createServer()

      // Timeout after 5 seconds to prevent hanging
      const timeout = setTimeout(() => {
        testServer.close()
        resolve(false)
      }, 5000)

      testServer.once('error', (err) => {
        clearTimeout(timeout)
        // Try to close the server even on error to prevent resource leak
        try {
          testServer.close()
        } catch (e) {
          // Ignore close errors
        }
        resolve(false)
      })

      testServer.once('listening', () => {
        clearTimeout(timeout)
        testServer.close(() => {
          resolve(true)
        })
      })

      testServer.listen(port, '127.0.0.1')
    })
  }

  /**
   * Get the actual port the server is running on
   */
  getPort(): number {
    return this.actualPort
  }

  setSchemaStatusHandler(getStatus: () => Promise<any>) {
    this.getSchemaStatusFn = getStatus
  }

  setRebuildIndexHandler(rebuildFn: (reindexAll: boolean) => Promise<any>) {
    this.rebuildIndexFn = rebuildFn
  }

  setCancelHandler(cancelFn: () => void) {
    this.cancelIndexingFn = cancelFn
  }

  setListTemplatesHandler(listTemplates: () => Promise<any>) {
    this.listTemplatesFn = listTemplates
  }

  async start(): Promise<void> {
    // Find an available port
    try {
      this.actualPort = await this.findAvailablePort(this.port)
    } catch (error) {
      console.error('Failed to find available port:', error)
      throw error
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`)

        if (url.pathname === '/') {
          // Serve HTML page
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(this.getIndexHtml())
        } else if (url.pathname === '/progress') {
          // Serve progress log as JSON
          try {
            const content = await fs.readFile(this.logFilePath, 'utf-8')
            const lines = content.trim().split('\n').filter(line => line.length > 0)
            const entries = lines.map(line => JSON.parse(line))

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(entries))
          } catch (error) {
            // If file doesn't exist or is empty, return empty array
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify([]))
          }
        } else if (url.pathname === '/schema-status') {
          // Get schema status
          if (!this.getSchemaStatusFn) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Schema status handler not available' }))
            return
          }
          try {
            const status = await this.getSchemaStatusFn()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(status))
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }))
          }
        } else if (url.pathname === '/cancel-indexing') {
          // Cancel indexing (POST only)
          console.error('[ProgressServer] /cancel-indexing endpoint called')
          console.error('[ProgressServer] Request method:', req.method)
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }))
            return
          }
          console.error('[ProgressServer] cancelIndexingFn available:', !!this.cancelIndexingFn)
          if (!this.cancelIndexingFn) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Cancel handler not available' }))
            return
          }
          try {
            console.error('[ProgressServer] Calling cancelIndexingFn()')
            this.cancelIndexingFn()
            console.error('[ProgressServer] cancelIndexingFn() completed')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: 'Cancellation requested' }))
          } catch (error) {
            console.error('[ProgressServer] Error in cancelIndexingFn:', error)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }))
          }
        } else if (url.pathname === '/rebuild-index') {
          // Rebuild index (POST only)
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }))
            return
          }
          if (!this.rebuildIndexFn) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Rebuild index handler not available' }))
            return
          }

          // Read request body to get reindex_all parameter
          let body = ''
          req.on('data', chunk => {
            body += chunk.toString()
          })
          req.on('error', (error) => {
            console.error('[ProgressServer] Error reading rebuild-index request:', error)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Failed to read request body' }))
          })
          req.on('end', async () => {
            try {
              const params = body ? JSON.parse(body) : {}
              const reindexAll = params.reindex_all || false
              const requestTimestamp = new Date().toISOString()
              console.error(`[ProgressServer] Rebuild index requested at ${requestTimestamp} with reindexAll:`, reindexAll)

              // Call the rebuild function and handle the MCP response format
              console.error('[ProgressServer RebuildIndexHandler] Rebuild index called with reindexAll:', reindexAll)
              const mcpResult = await this.rebuildIndexFn!(reindexAll)
              console.error('[ProgressServer RebuildIndexHandler] Rebuild index completed, isError:', mcpResult.isError)

              // Extract the message from MCP response format
              const message = mcpResult.content && mcpResult.content[0] && mcpResult.content[0].text
                ? mcpResult.content[0].text.split('\n')[0] // Get first line as message
                : (reindexAll ? 'Rebuild' : 'Update') + ' started'

              // Check if the operation was rejected or failed
              if (mcpResult.isError) {
                console.error('[ProgressServer] Rebuild index rejected (concurrent request):', message)
                res.writeHead(409, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  success: false,
                  error: message
                }))
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  success: true,
                  message: message
                }))
              }
            } catch (error) {
              console.error('[ProgressServer] Error in rebuild-index:', error)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
              }))
            }
          })
        } else if (url.pathname === '/api/templates') {
          // List available templates
          if (req.method === 'GET') {
            if (!this.listTemplatesFn) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Templates handler not available' }))
              return
            }
            try {
              const templates = await this.listTemplatesFn()
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(templates))
            } catch (error) {
              console.error('[ProgressServer] Error listing templates:', error)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }))
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'text/plain' })
            res.end('Method Not Allowed')
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
        }
      })

      this.server.on('error', (error: any) => {
        console.error(`Console server error:`, error)
        reject(error)
      })

      // Monitor connections
      this.server.on('connection', (socket: net.Socket) => {
        this.activeConnections.add(socket)
        this.connectionCallbacks.forEach(cb => cb())

        socket.on('close', () => {
          this.activeConnections.delete(socket)
          if (this.activeConnections.size === 0) {
            this.disconnectionCallbacks.forEach(cb => cb())
          }
        })
      })

      // Listen on 127.0.0.1 (IPv4 localhost) to avoid IPv6 issues
      this.server.listen(this.actualPort, '127.0.0.1', () => {
        console.error(`Console available at: http://localhost:${this.actualPort}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.error('Progress server stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  onConnection(callback: () => void): void {
    this.connectionCallbacks.push(callback)
  }

  onDisconnection(callback: () => void): void {
    this.disconnectionCallbacks.push(callback)
  }

  hasActiveConnections(): boolean {
    return this.activeConnections.size > 0
  }

  private getIndexHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Index Manager</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
      padding: 40px;
    }
    .header {
      margin-bottom: 30px;
      border-bottom: 3px solid #667eea;
      padding-bottom: 20px;
    }
    h1 {
      font-size: 32px;
      margin-bottom: 12px;
      color: #667eea;
      font-weight: 700;
    }
    .project-path {
      font-family: 'Courier New', monospace;
      background: #f8fafc;
      padding: 10px 15px;
      border-radius: 6px;
      font-size: 13px;
      color: #475569;
      border-left: 4px solid #667eea;
      word-break: break-all;
    }
    .status {
      padding: 15px 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-idle {
      background: #f0f4f8;
      color: #64748b;
    }
    .status-running {
      background: #dbeafe;
      color: #1e40af;
      animation: pulse 2s ease-in-out infinite;
    }
    .status-complete {
      background: #dcfce7;
      color: #166534;
    }
    .status-error {
      background: #fee2e2;
      color: #991b1b;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .progress-container {
      margin-bottom: 30px;
    }
    .progress-bar-wrapper {
      background: #f0f4f8;
      border-radius: 10px;
      height: 30px;
      overflow: hidden;
      margin-bottom: 15px;
      position: relative;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      transition: width 0.5s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 600;
      font-size: 14px;
    }
    .progress-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 15px;
    }
    .detail-card {
      background: #f8fafc;
      padding: 15px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    .detail-label {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .detail-value {
      font-size: 20px;
      font-weight: 600;
      color: #1e293b;
    }
    .section {
      margin-bottom: 30px;
    }
    .section-header {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 15px;
      color: #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .reload-button {
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .reload-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .reload-button:active {
      transform: translateY(0);
    }
    .reload-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .log-container {
      margin-top: 40px;
      border-top: 3px solid #667eea;
      padding-top: 25px;
    }
    .log-header {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 15px;
      color: #334155;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .log-entries {
      max-height: 300px;
      overflow-y: auto;
      background: #f8fafc;
      border-radius: 8px;
      padding: 15px;
    }
    .log-entry {
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
      font-size: 13px;
      color: #475569;
    }
    .log-entry:last-child {
      border-bottom: none;
    }
    .log-timestamp {
      color: #94a3b8;
      font-size: 11px;
      margin-right: 10px;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s ease-in-out infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .project-stats-container {
      margin-bottom: 30px;
    }
    .project-stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
    }
    .stats-card {
      background: #f8fafc;
      border-radius: 8px;
      padding: 20px;
      border-left: 4px solid #667eea;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .stats-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
    }
    .stats-label {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 500;
    }
    .stats-value {
      font-size: 28px;
      font-weight: 700;
      color: #1e293b;
    }
    .status-cancelled {
      background: #fed7aa;
      color: #9a3412;
    }
    .loading-spinner {
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      width: 14px;
      height: 14px;
      animation: spin 1s linear infinite;
      display: inline-block;
      margin-right: 8px;
      vertical-align: middle;
    }
    .indexing-container {
      margin-bottom: 30px;
    }
    .section-divider {
      border: none;
      border-top: 2px solid #e2e8f0;
      margin: 25px 0;
    }
    .progress-area {
      margin-bottom: 25px;
    }
    .operations-area {
      padding: 20px;
      background: #f8fafc;
      border-radius: 8px;
    }
    .operations-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
    }
    .operation-button {
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .operation-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .operation-button:active {
      transform: translateY(0);
    }
    .operation-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background: #94a3b8;
    }
    .operation-button.destructive {
      background: linear-gradient(90deg, #dc2626 0%, #991b1b 100%);
    }
    .operation-button.destructive:hover {
      box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
    }
    .operation-button.cancel {
      background: linear-gradient(90deg, #f97316 0%, #ea580c 100%);
    }
    .operation-button.cancel:hover {
      box-shadow: 0 4px 12px rgba(249, 115, 22, 0.4);
    }
    /* Embedding Settings Styles */
    .settings-container {
      margin-bottom: 30px;
    }
    .settings-header {
      font-size: 20px;
      font-weight: 700;
      color: #667eea;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .settings-header-collapsible {
      font-size: 16px;
      font-weight: 600;
      color: #475569;
      padding: 15px;
      background: #f8fafc;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 0.3s ease;
      margin-bottom: 15px;
    }
    .settings-header-collapsible:hover {
      background: #e2e8f0;
    }
    .expand-icon {
      font-size: 14px;
      transition: transform 0.3s ease;
    }
    .expand-icon.expanded {
      transform: rotate(180deg);
    }
    .settings-content {
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    .settings-note {
      background: #fef3c7;
      padding: 12px 15px;
      border-radius: 8px;
      font-size: 13px;
      color: #92400e;
      border-left: 4px solid #f59e0b;
      margin-bottom: 15px;
    }
    .settings-note a {
      color: #b45309;
      text-decoration: underline;
      font-weight: 600;
    }
    .settings-mode {
      background: #f8fafc;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 15px;
      border-left: 4px solid #667eea;
    }
    .settings-mode-label {
      font-weight: 600;
      color: #475569;
      margin-bottom: 8px;
    }
    .settings-mode-value {
      font-family: 'Courier New', monospace;
      color: #1e40af;
      font-size: 14px;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .settings-item {
      background: #f8fafc;
      padding: 12px;
      border-radius: 6px;
    }
    .settings-item-label {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 5px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .settings-item-value {
      font-family: 'Courier New', monospace;
      font-size: 14px;
      color: #1e293b;
      word-break: break-all;
    }
    .settings-item-value.masked {
      letter-spacing: 2px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📑 Index Manager</h1>
      <div class="project-path">
        <strong>📁 Project:</strong> <span id="project-path">Loading...</span>
      </div>
    </div>

    <div class="project-stats-container section">
      <div class="section-header">
        📊 Project Statistics
        <button id="reload-stats-button" class="reload-button" title="Reload statistics now">
          🔄 Reload
        </button>
      </div>
      <div class="project-stats-grid">
        <div class="stats-card">
          <div class="stats-label">Total Files</div>
          <div class="stats-value" id="total-files">-</div>
        </div>
        <div class="stats-card">
          <div class="stats-label">Indexed Files</div>
          <div class="stats-value" id="indexed-files">-</div>
        </div>
        <div class="stats-card">
          <div class="stats-label">Not Indexed</div>
          <div class="stats-value" id="not-indexed-files">-</div>
        </div>
        <div class="stats-card">
          <div class="stats-label">Deleted Files</div>
          <div class="stats-value" id="deleted-files">-</div>
        </div>
      </div>
    </div>

    <div class="indexing-container section">
      <div class="section-header">📈 Indexing Status & Operations</div>

      <div id="status" class="status status-idle">
        <span id="status-icon">⏸️</span>
        <span>Index Status: </span>
        <span id="status-text">No Index</span>
      </div>

      <div class="progress-area">
        <div class="progress-bar-wrapper">
          <div id="progress-bar" class="progress-bar" style="width: 0%">
            <span id="progress-text">0%</span>
          </div>
        </div>

        <div class="progress-details">
          <div class="detail-card">
            <div class="detail-label">Chunks (Indexed / Total)</div>
            <div class="detail-value" id="chunks-value">0 / 0</div>
          </div>
          <div class="detail-card">
            <div class="detail-label">Files (Indexed / Total)</div>
            <div class="detail-value" id="files-value">0 / 0</div>
          </div>
        </div>
      </div>

      <hr class="section-divider">

      <div class="operations-area">
        <div class="operations-grid">
          <button id="update-index-button" class="operation-button">
            📝 Update Index
          </button>
          <button id="rebuild-index-button" class="operation-button destructive">
            🔄 Rebuild Index
          </button>
          <button id="cancel-index-button" class="operation-button cancel" style="display: none;">
            🚫 Cancel
          </button>
        </div>
      </div>
    </div>

    <div class="log-container">
      <div class="log-header">📝 Activity Log</div>
      <div class="log-entries" id="log-entries">
        <div class="log-entry">No activity yet.</div>
      </div>
    </div>

    <div class="settings-container section">
      <div class="settings-header-collapsible" onclick="toggleSettings()">
        <span>ℹ️ Current Configuration</span>
        <span class="expand-icon" id="settings-expand-icon">▼</span>
      </div>

      <div class="settings-content" id="settings-content" style="display: none;">
        <div class="settings-note">
          📋 All settings are configured via environment variables (.env file).
        </div>
        <div class="settings-note">
          🔄 To change settings:<br>
          1. Edit your .env file<br>
          2. Use the <code>reload_config</code> MCP tool from Claude Code<br>
          3. Or restart the MCP server
        </div>
        <div class="settings-note">
          ⚠️ <strong>To apply changes to this Index Manager:</strong><br>
          Use <code>stop_index_manager</code> and <code>open_index_manager</code> MCP tools to restart this process.<br>
          The Index Manager runs independently and is not affected by <code>reload_config</code>.
        </div>
        <div class="settings-note">
          📖 See README.md for detailed configuration options.
        </div>
      </div>
    </div>
  </div>

  <script>
    let lastEntryCount = 0;
    let progressPollingInterval = 5000; // Default 5 seconds
    let progressTimer = null;

    function scheduleNextProgressFetch() {
      if (progressTimer) {
        clearTimeout(progressTimer);
      }
      progressTimer = setTimeout(() => {
        fetchProgress();
      }, progressPollingInterval);
    }

    async function fetchProgress() {
      try {
        const response = await fetch('/progress');
        const entries = await response.json();

        if (entries.length === 0) {
          scheduleNextProgressFetch();
          return;
        }

        const latestEntry = entries[entries.length - 1];
        updateUI(latestEntry);

        // Check if indexing is in progress and adjust polling interval
        if (latestEntry.type === 'start' || latestEntry.type === 'progress') {
          // Indexing in progress - poll every 2 seconds
          if (progressPollingInterval !== 2000) {
            progressPollingInterval = 2000;
            console.log('Indexing in progress, switching to 2s polling');
          }
        } else {
          // Indexing finished/error/cancelled - poll every 5 seconds
          if (progressPollingInterval !== 5000) {
            progressPollingInterval = 5000;
            console.log('Indexing finished, switching to 5s polling');
          }
        }

        // Update log if new entries
        if (entries.length > lastEntryCount) {
          updateLog(entries);
          lastEntryCount = entries.length;
        }
      } catch (error) {
        console.error('Failed to fetch progress:', error);
      } finally {
        scheduleNextProgressFetch();
      }
    }

    async function fetchSchemaStatus(isManual = false) {
      const reloadButton = document.getElementById('reload-stats-button');
      try {
        if (isManual && reloadButton) {
          reloadButton.disabled = true;
          reloadButton.textContent = '⏳ Loading...';
        }

        const response = await fetch('/schema-status');
        const status = await response.json();

        if (status.error) {
          console.error('Schema status error:', status.error);
          return;
        }

        updateSchemaStatus(status);
        // Trigger UI update with latest progress data
        if (lastEntryCount > 0) {
          const response = await fetch('/progress');
          const entries = await response.json();
          if (entries.length > 0) {
            const latestEntry = entries[entries.length - 1];
            updateUI(latestEntry);
          }
        }
      } catch (error) {
        console.error('Failed to fetch schema status:', error);
      } finally {
        if (isManual && reloadButton) {
          reloadButton.disabled = false;
          reloadButton.textContent = '🔄 Reload';
        }
      }
    }

    function updateSchemaStatus(status) {
      // Update project path
      if (status.workspacePath) {
        const projectPathEl = document.getElementById('project-path');
        projectPathEl.textContent = status.workspacePath;
      }

      // Update project statistics
      if (status.projectStats) {
        const totalFilesEl = document.getElementById('total-files');
        const indexedFilesEl = document.getElementById('indexed-files');
        const notIndexedFilesEl = document.getElementById('not-indexed-files');
        const deletedFilesEl = document.getElementById('deleted-files');

        totalFilesEl.textContent = status.projectStats.totalFilesInProject;
        indexedFilesEl.textContent = status.projectStats.indexedFiles;
        notIndexedFilesEl.textContent = status.projectStats.notIndexedFiles;
        deletedFilesEl.textContent = status.projectStats.deletedFiles;

        // Update index status based on indexed files and not indexed files
        const statusEl = document.getElementById('status');
        const statusIcon = document.getElementById('status-icon');
        const statusText = document.getElementById('status-text');

        // Only update if there's no active progress or operation completion state
        // (avoid overriding active index operations or just-completed states)
        if (!statusEl.classList.contains('status-running') &&
            !statusEl.classList.contains('status-cancelled') &&
            !statusEl.classList.contains('status-complete') &&
            !statusEl.classList.contains('status-error')) {
          const indexedFiles = status.projectStats.indexedFiles;
          const notIndexedFiles = status.projectStats.notIndexedFiles;
          const totalFiles = status.projectStats.totalFilesInProject;

          if (indexedFiles === 0 && totalFiles === 0) {
            // No files to index at all
            statusEl.className = 'status status-idle';
            statusIcon.textContent = '⏸️';
            statusText.textContent = 'No Index';
          } else if (indexedFiles === 0) {
            // Files exist but none are indexed
            statusEl.className = 'status status-idle';
            statusIcon.textContent = '⏸️';
            statusText.textContent = 'No Index';
          } else if (notIndexedFiles > 0) {
            // Some files are indexed but others are not
            statusEl.className = 'status status-running';
            statusIcon.textContent = '🔄';
            statusText.textContent = 'Needs Update';
          } else {
            // All files are indexed
            statusEl.className = 'status status-complete';
            statusIcon.textContent = '✅';
            statusText.textContent = 'Up to Date';
          }
        }
      }
    }

    async function updateIndex() {
      const updateButton = document.getElementById('update-index-button');

      // Show loading state
      updateButton.disabled = true;
      updateButton.textContent = '⏳ Updating...';

      try {
        const response = await fetch('/rebuild-index', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ reindex_all: false })
        });

        if (!response.ok) {
          let errorMsg = 'Server error';
          try {
            const result = await response.json();
            errorMsg = result.error || errorMsg;
          } catch (e) {
            errorMsg = response.statusText || errorMsg;
          }
          throw new Error(errorMsg);
        }

        const result = await response.json();
        console.error('Update index result:', result);
      } catch (error) {
        console.error('Update index error:', error);
        alert('Failed to update index: ' + (error.message || 'Network error. Please check if the server is running.'));
      } finally {
        updateButton.disabled = false;
        updateButton.textContent = '📝 Update Index';
      }
    }

    async function rebuildIndex() {
      const rebuildButton = document.getElementById('rebuild-index-button');

      if (!confirm('⚠️ WARNING: This will rebuild the entire index from scratch. All files will be re-indexed, which may take time and consume API quota. Are you sure?')) {
        return;
      }

      // Show loading state
      rebuildButton.disabled = true;
      rebuildButton.textContent = '⏳ Rebuilding...';

      try {
        const response = await fetch('/rebuild-index', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ reindex_all: true })
        });

        if (!response.ok) {
          let errorMsg = 'Server error';
          try {
            const result = await response.json();
            errorMsg = result.error || errorMsg;
          } catch (e) {
            errorMsg = response.statusText || errorMsg;
          }
          throw new Error(errorMsg);
        }

        const result = await response.json();
        console.error('Rebuild index result:', result);
      } catch (error) {
        console.error('Rebuild index error:', error);
        alert('Failed to rebuild index: ' + (error.message || 'Network error. Please check if the server is running.'));
      } finally {
        rebuildButton.disabled = false;
        rebuildButton.textContent = '🔄 Rebuild Index';
      }
    }

    async function cancelIndexing() {
      const cancelButton = document.getElementById('cancel-index-button');

      // Show loading state
      cancelButton.disabled = true;
      cancelButton.textContent = '⏳ Cancelling...';

      try {
        const response = await fetch('/cancel-indexing', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const result = await response.json();

        if (response.ok) {
          console.error('Cancellation requested:', result.message);
        } else {
          alert('Failed to cancel indexing: ' + (result.error || 'Unknown error'));
          cancelButton.disabled = false;
          cancelButton.textContent = '🚫 Cancel';
        }
      } catch (error) {
        alert('Failed to cancel indexing: ' + error.message);
        cancelButton.disabled = false;
        cancelButton.textContent = '🚫 Cancel';
      }
    }

    // Attach event listeners
    document.getElementById('update-index-button').addEventListener('click', updateIndex);
    document.getElementById('rebuild-index-button').addEventListener('click', rebuildIndex);
    document.getElementById('cancel-index-button').addEventListener('click', cancelIndexing);

    function updateUI(entry) {
      const { type, data } = entry;
      const statusEl = document.getElementById('status');
      const statusIcon = document.getElementById('status-icon');
      const statusText = document.getElementById('status-text');
      const progressBar = document.getElementById('progress-bar');
      const progressText = document.getElementById('progress-text');
      const chunksValue = document.getElementById('chunks-value');
      const filesValue = document.getElementById('files-value');
      const cancelButton = document.getElementById('cancel-index-button');

      // Update progress bar
      const percentage = data.percentage || 0;
      progressBar.style.width = percentage + '%';
      progressText.textContent = percentage + '%';

      // Update details (current update progress only)
      chunksValue.textContent = (data.completedChunks || 0) + ' / ' + (data.totalChunks || 0);
      filesValue.textContent = (data.completedFiles || 0) + ' / ' + (data.totalFiles || 0);

      // Update status and cancel button visibility
      statusEl.className = 'status';
      if (type === 'start' || type === 'progress') {
        statusEl.classList.add('status-running');
        statusIcon.innerHTML = '<div class="spinner"></div>';
        if (data.waitingForRateLimit) {
          statusText.textContent = 'Updating (⏳ Waiting for API rate limit...)';
        } else {
          statusText.textContent = 'Updating';
        }
        // Show cancel button when indexing and reset its state
        cancelButton.style.display = 'block';
        cancelButton.disabled = false;
        cancelButton.textContent = '🚫 Cancel';
      } else if (type === 'complete') {
        statusEl.classList.add('status-complete');
        statusIcon.textContent = '✅';
        statusText.textContent = 'Finished';
        cancelButton.style.display = 'none';

        // Update statistics immediately after completion
        setTimeout(() => {
          fetchSchemaStatus();
        }, 500); // Small delay to ensure the completion is visible
      } else if (type === 'error') {
        statusEl.classList.add('status-error');
        statusIcon.textContent = '❌';
        statusText.textContent = 'Error: ' + (data.error || 'Unknown error');
        cancelButton.style.display = 'none';

        // Update statistics immediately after error
        setTimeout(() => {
          fetchSchemaStatus();
        }, 500);
      } else if (type === 'cancelled') {
        statusEl.classList.add('status-cancelled');
        statusIcon.textContent = '🚫';
        statusText.textContent = 'Cancelled';
        cancelButton.style.display = 'none';

        // Update statistics immediately after cancellation
        setTimeout(() => {
          fetchSchemaStatus();
        }, 500);
      }
    }

    function updateLog(entries) {
      const logContainer = document.getElementById('log-entries');
      logContainer.innerHTML = '';

      // Show last 3 entries
      const recentEntries = entries.slice(-3);

      recentEntries.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'log-entry';

        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        const message = entry.data.message || (entry.type + ': ' + entry.data.completedChunks + '/' + entry.data.totalChunks + ' chunks');

        div.innerHTML = '<span class="log-timestamp">' + timestamp + '</span>' + message;
        logContainer.appendChild(div);
      });

      // Scroll to bottom
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    // Start progress polling (dynamic interval: 5s base, 2s when indexing)
    fetchProgress();

    // Fetch schema status every 60 seconds
    setInterval(fetchSchemaStatus, 60000);
    fetchSchemaStatus();

    // Reload button handler
    document.getElementById('reload-stats-button').addEventListener('click', () => {
      fetchSchemaStatus(true);
    });

    // Toggle settings section
    function toggleSettings() {
      const content = document.getElementById('settings-content');
      const icon = document.getElementById('settings-expand-icon');

      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.classList.add('expanded');
      } else {
        content.style.display = 'none';
        icon.classList.remove('expanded');
      }
    }

    // Make functions available globally for onclick handlers
    window.toggleSettings = toggleSettings;
  </script>
</body>
</html>`;
  }
}
