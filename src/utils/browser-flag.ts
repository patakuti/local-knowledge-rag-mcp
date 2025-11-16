import fs from 'fs'
import path from 'path'
import { getWorkspaceTempDir, getBaseTempDir } from './workspace-utils.js'

interface BrowserFlagData {
  servers: {
    pid: number
    port: number
    timestamp: string
  }[]
}

/**
 * Persistent flag to track which console ports have had their browsers opened
 * Supports multiple server instances with PID and port tracking
 * Each workspace has its own flag file to allow multiple workspaces to open their consoles
 * Each unique port within a workspace will open its browser once
 */
export class BrowserFlag {
  private flagPath: string

  constructor(workspaceId?: string) {
    // Use workspace-specific temp directory for flag file
    // If no workspaceId provided, use the base temp directory
    const tempDir = workspaceId
      ? getWorkspaceTempDir(workspaceId)
      : getBaseTempDir()
    this.flagPath = path.join(tempDir, 'browser-opened.flag')
  }

  /**
   * Check if a process is still running
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0)
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Read and clean up the flag file
   * Returns cleaned data and whether any cleanup occurred
   */
  private readAndCleanup(): { data: BrowserFlagData; cleaned: boolean } {
    try {
      if (!fs.existsSync(this.flagPath)) {
        return { data: { servers: [] }, cleaned: false }
      }

      const content = fs.readFileSync(this.flagPath, 'utf-8')
      const data: BrowserFlagData = JSON.parse(content)

      // Clean up dead PIDs
      const before = data.servers.length
      data.servers = data.servers.filter(s => this.isProcessRunning(s.pid))
      const cleaned = data.servers.length < before

      if (cleaned) {
        console.error(`[BrowserFlag] Cleaned up ${before - data.servers.length} dead server(s)`)
      }

      return { data, cleaned }
    } catch (error) {
      console.error('[BrowserFlag] Error reading flag, resetting:', error)
      return { data: { servers: [] }, cleaned: true }
    }
  }

  /**
   * Write flag data to file
   */
  private write(data: BrowserFlagData): void {
    try {
      if (data.servers.length === 0) {
        // No servers left, delete the file
        if (fs.existsSync(this.flagPath)) {
          fs.unlinkSync(this.flagPath)
          console.error('[BrowserFlag] All servers stopped, flag file deleted')
        }
      } else {
        fs.writeFileSync(this.flagPath, JSON.stringify(data, null, 2))
      }
    } catch (error) {
      console.error('[BrowserFlag] Error writing flag:', error)
    }
  }

  /**
   * Check if browser has been opened for a specific port
   * @param port - The port number to check
   * @returns true if a browser has been opened for this port
   */
  hasOpened(port?: number): boolean {
    const { data, cleaned } = this.readAndCleanup()

    if (cleaned) {
      this.write(data)
    }

    // If no port specified, check if any server exists (legacy behavior)
    if (port === undefined) {
      const hasServers = data.servers.length > 0
      console.error(`[BrowserFlag] Flag check: ${hasServers ? `${data.servers.length} active server(s)` : 'no active servers'}`)
      return hasServers
    }

    // Check if this specific port has been opened
    const hasPort = data.servers.some(s => s.port === port)
    console.error(`[BrowserFlag] Flag check for port ${port}: ${hasPort ? 'already opened' : 'not opened yet'} (${data.servers.length} total active server(s))`)
    return hasPort
  }

  /**
   * Register this server instance (mark browser as opened)
   * @param port - The port number for this server
   */
  markOpened(port: number): void {
    const { data } = this.readAndCleanup()

    // Check if this PID is already registered
    const existingIndex = data.servers.findIndex(s => s.pid === process.pid)
    if (existingIndex !== -1) {
      console.error(`[BrowserFlag] Server PID ${process.pid} already registered`)
      return
    }

    // Add this server
    data.servers.push({
      pid: process.pid,
      port: port,
      timestamp: new Date().toISOString()
    })

    this.write(data)
    console.error(`[BrowserFlag] Server registered (PID: ${process.pid}, port: ${port}, total: ${data.servers.length})`)
  }

  /**
   * Unregister this server instance
   */
  clear(): void {
    const { data } = this.readAndCleanup()

    // Remove this PID
    const before = data.servers.length
    data.servers = data.servers.filter(s => s.pid !== process.pid)

    if (data.servers.length < before) {
      this.write(data)
      console.error(`[BrowserFlag] Server unregistered (PID: ${process.pid}, remaining: ${data.servers.length})`)
    } else {
      console.error(`[BrowserFlag] Server PID ${process.pid} cleanup: not the registered instance (normal for secondary processes)`)
    }
  }
}
