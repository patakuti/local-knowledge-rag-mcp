import fs from 'fs'
import path from 'path'
import { getWorkspaceTempDir } from './workspace-utils.js'

interface ProgressServerFlagData {
  server?: {
    pid: number
    port: number
    timestamp: string
  }
}

/**
 * Persistent flag to coordinate ProgressServer startup across multiple MCP server processes
 * Ensures only one ProgressServer runs per workspace, even when multiple processes are active
 * Each workspace has its own flag file
 */
export class ProgressServerFlag {
  private flagPath: string

  constructor(workspaceId: string) {
    // Use workspace-specific temp directory for flag file
    const tempDir = getWorkspaceTempDir(workspaceId)
    this.flagPath = path.join(tempDir, 'progress-server.flag')
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
  private readAndCleanup(): { data: ProgressServerFlagData; cleaned: boolean } {
    try {
      if (!fs.existsSync(this.flagPath)) {
        return { data: {}, cleaned: false }
      }

      const content = fs.readFileSync(this.flagPath, 'utf-8')
      const data: ProgressServerFlagData = JSON.parse(content)

      // Clean up if the server process is dead
      let cleaned = false
      if (data.server && !this.isProcessRunning(data.server.pid)) {
        console.error(`[ProgressServerFlag] Cleaned up dead server (PID: ${data.server.pid})`)
        data.server = undefined
        cleaned = true
      }

      return { data, cleaned }
    } catch (error) {
      console.error('[ProgressServerFlag] Error reading flag, resetting:', error)
      return { data: {}, cleaned: true }
    }
  }

  /**
   * Write flag data to file
   */
  private write(data: ProgressServerFlagData): void {
    try {
      if (!data.server) {
        // No server registered, delete the file
        if (fs.existsSync(this.flagPath)) {
          fs.unlinkSync(this.flagPath)
          console.error('[ProgressServerFlag] Server stopped, flag file deleted')
        }
      } else {
        fs.writeFileSync(this.flagPath, JSON.stringify(data, null, 2))
      }
    } catch (error) {
      console.error('[ProgressServerFlag] Error writing flag:', error)
    }
  }

  /**
   * Check if a ProgressServer is already running for this workspace
   * @returns Server info if running, undefined otherwise
   */
  getRunningServer(): { pid: number; port: number } | undefined {
    const { data, cleaned } = this.readAndCleanup()

    if (cleaned) {
      this.write(data)
    }

    if (data.server) {
      console.error(`[ProgressServerFlag] Found running server (PID: ${data.server.pid}, port: ${data.server.port})`)
      return { pid: data.server.pid, port: data.server.port }
    }

    console.error('[ProgressServerFlag] No running server found')
    return undefined
  }

  /**
   * Register this process as the ProgressServer owner
   * @param port - The port number for the ProgressServer
   * @returns true if successfully registered, false if another server is already running
   */
  tryRegister(port: number): boolean {
    const { data } = this.readAndCleanup()

    // Check if another server is already running
    if (data.server && this.isProcessRunning(data.server.pid)) {
      console.error(`[ProgressServerFlag] Another server already running (PID: ${data.server.pid}, port: ${data.server.port})`)
      return false
    }

    // Register this server
    data.server = {
      pid: process.pid,
      port: port,
      timestamp: new Date().toISOString()
    }

    this.write(data)
    console.error(`[ProgressServerFlag] Server registered (PID: ${process.pid}, port: ${port})`)
    return true
  }

  /**
   * Unregister this process as the ProgressServer owner
   */
  unregister(): void {
    const { data } = this.readAndCleanup()

    if (data.server?.pid === process.pid) {
      data.server = undefined
      this.write(data)
      console.error(`[ProgressServerFlag] Server unregistered (PID: ${process.pid})`)
    } else {
      console.error(`[ProgressServerFlag] Server PID ${process.pid} cleanup: not the registered instance (normal for secondary processes)`)
    }
  }
}
