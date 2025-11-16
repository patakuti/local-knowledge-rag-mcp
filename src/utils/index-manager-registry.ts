import fs from 'fs'
import path from 'path'
import os from 'os'

interface IndexManagerInfo {
  workspaceId: string
  workspacePath: string
  pid: number
  port: number
  startTime: string
  lastActivity?: string
}

interface RegistryData {
  managers: IndexManagerInfo[]
}

export class IndexManagerRegistry {
  private registryPath: string

  constructor() {
    const homeDir = os.homedir()
    const configDir = path.join(homeDir, '.local-knowledge-rag-mcp')
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    this.registryPath = path.join(configDir, 'index-managers.json')
  }

  private read(): RegistryData {
    if (!fs.existsSync(this.registryPath)) {
      return { managers: [] }
    }

    try {
      const content = fs.readFileSync(this.registryPath, 'utf-8')
      return JSON.parse(content)
    } catch (error) {
      console.error('[Registry] Error reading registry:', error)
      return { managers: [] }
    }
  }

  private write(data: RegistryData): void {
    try {
      fs.writeFileSync(
        this.registryPath,
        JSON.stringify(data, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('[Registry] Error writing registry:', error)
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      console.error(`[Registry] isProcessAlive(${pid}): true`)
      return true
    } catch (error: any) {
      console.error(`[Registry] isProcessAlive(${pid}): false (${error.code})`)
      return false
    }
  }

  /**
   * Clean up dead processes
   */
  private cleanup(data: RegistryData): RegistryData {
    const before = data.managers.length
    console.error(`[Registry] cleanup: checking ${before} manager(s)`)
    data.managers = data.managers.filter(m => {
      const alive = this.isProcessAlive(m.pid)
      console.error(`[Registry]   - PID ${m.pid}: ${alive ? 'KEEP' : 'REMOVE'}`)
      return alive
    })

    if (data.managers.length < before) {
      console.error(`[Registry] Cleaned up ${before - data.managers.length} dead manager(s)`)
    }

    return data
  }

  /**
   * Register Index Manager
   */
  register(info: IndexManagerInfo): void {
    let data = this.read()
    data = this.cleanup(data)

    // Remove existing entry
    data.managers = data.managers.filter(
      m => m.workspaceId !== info.workspaceId
    )

    // Register new entry
    data.managers.push({
      ...info,
      lastActivity: new Date().toISOString()
    })

    this.write(data)
    console.error(`[Registry] Registered manager for workspace ${info.workspaceId} (PID: ${info.pid}, port: ${info.port})`)
  }

  /**
   * Unregister Index Manager
   */
  unregister(workspaceId: string): void {
    const data = this.read()
    const before = data.managers.length
    data.managers = data.managers.filter(m => m.workspaceId !== workspaceId)

    if (data.managers.length < before) {
      this.write(data)
      console.error(`[Registry] Unregistered manager for workspace ${workspaceId}`)
    }
  }

  /**
   * Get Index Manager for specific workspace
   */
  getByWorkspace(workspaceId: string): IndexManagerInfo | undefined {
    let data = this.read()
    console.error(`[Registry] getByWorkspace('${workspaceId}'): found ${data.managers.length} manager(s) before cleanup`)
    data = this.cleanup(data)
    console.error(`[Registry] After cleanup: ${data.managers.length} manager(s) remaining`)
    this.write(data)

    const result = data.managers.find(m => m.workspaceId === workspaceId)
    console.error(`[Registry] Result: ${result ? 'FOUND' : 'NOT FOUND'}`)
    return result
  }

  /**
   * Get all Index Managers
   */
  getAll(): IndexManagerInfo[] {
    let data = this.read()
    data = this.cleanup(data)
    this.write(data)

    return data.managers
  }

  /**
   * Check if port is in use
   */
  isPortInUse(port: number): boolean {
    const data = this.read()
    return data.managers.some(m => m.port === port)
  }

  /**
   * Find available port
   */
  findAvailablePort(workspaceId: string, basePort: number = 3456): number {
    // If existing manager exists, return its port
    const existing = this.getByWorkspace(workspaceId)
    if (existing) {
      return existing.port
    }

    // For new managers, find unused port
    let port = basePort
    while (this.isPortInUse(port)) {
      port++
      if (port > basePort + 100) {
        throw new Error('No available ports (checked 100 ports)')
      }
    }

    return port
  }

  /**
   * Clean up all dead processes and return statistics
   * (for startup and maintenance)
   */
  cleanupAll(): { before: number; after: number; removed: number } {
    console.error('[Registry] cleanupAll: Starting explicit cleanup')
    let data = this.read()
    const before = data.managers.length
    data = this.cleanup(data)
    const after = data.managers.length
    const removed = before - after

    this.write(data)

    console.error(`[Registry] cleanupAll: Completed (before: ${before}, after: ${after}, removed: ${removed})`)
    return { before, after, removed }
  }
}
