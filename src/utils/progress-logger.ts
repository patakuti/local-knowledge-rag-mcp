import fs from 'fs/promises'
import path from 'path'
import type { IndexProgress } from '../types/rag.types.js'
import { getWorkspaceTempDir } from './workspace-utils.js'

export type ProgressLogEntry = {
  timestamp: string
  type: 'start' | 'progress' | 'complete' | 'error' | 'cancelled' | 'warning'
  data: IndexProgress & {
    percentage?: number
    message?: string
    error?: string
    details?: any // For additional context like failed files, skipped files, etc.
  }
}

export class ProgressLogger {
  private logFilePath: string
  private isEnabled: boolean

  constructor(workspaceId: string) {
    const tempDir = getWorkspaceTempDir(workspaceId)
    this.logFilePath = path.join(tempDir, 'progress.log')
    this.isEnabled = true
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.logFilePath)
      await fs.mkdir(dir, { recursive: true })
      // Clear previous log
      await fs.writeFile(this.logFilePath, '', 'utf-8')
    } catch (error) {
      console.warn('Failed to initialize progress logger:', error)
      this.isEnabled = false
    }
  }

  async logStart(totalChunks: number, totalFiles: number): Promise<void> {
    if (!this.isEnabled) return

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'start',
      data: {
        completedChunks: 0,
        totalChunks,
        totalFiles,
        completedFiles: 0,
        percentage: 0,
        message: 'Indexing started',
      },
    }

    await this.writeEntry(entry)
  }

  async logProgress(progress: IndexProgress): Promise<void> {
    if (!this.isEnabled) return

    const percentage = progress.totalChunks > 0
      ? Math.floor((progress.completedChunks / progress.totalChunks) * 100)
      : 0

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'progress',
      data: {
        ...progress,
        percentage,
      },
    }

    await this.writeEntry(entry)
  }

  async logComplete(totalChunks: number, totalFiles: number, durationSeconds: number): Promise<void> {
    if (!this.isEnabled) return

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'complete',
      data: {
        completedChunks: totalChunks,
        totalChunks,
        totalFiles,
        completedFiles: totalFiles,
        percentage: 100,
        message: `Indexing complete in ${durationSeconds.toFixed(1)}s`,
      },
    }

    await this.writeEntry(entry)
  }

  async logError(error: string): Promise<void> {
    if (!this.isEnabled) return

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'error',
      data: {
        completedChunks: 0,
        totalChunks: 0,
        totalFiles: 0,
        error,
        message: 'Indexing failed',
      },
    }

    await this.writeEntry(entry)
  }

  async logCancelled(completedChunks: number, totalChunks: number, totalFiles: number, completedFiles: number): Promise<void> {
    if (!this.isEnabled) return

    const percentage = totalChunks > 0
      ? Math.floor((completedChunks / totalChunks) * 100)
      : 0

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'cancelled',
      data: {
        completedChunks,
        totalChunks,
        totalFiles,
        completedFiles,
        percentage,
        message: `Indexing cancelled at ${completedChunks}/${totalChunks} chunks (${percentage}%)`,
        isCancelled: true,
      },
    }

    await this.writeEntry(entry)
  }

  async logWarning(message: string, details?: any): Promise<void> {
    if (!this.isEnabled) return

    const entry: ProgressLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'warning',
      data: {
        completedChunks: 0,
        totalChunks: 0,
        totalFiles: 0,
        message,
        details,
      },
    }

    await this.writeEntry(entry)
  }

  private async writeEntry(entry: ProgressLogEntry): Promise<void> {
    try {
      const line = JSON.stringify(entry) + '\n'
      await fs.appendFile(this.logFilePath, line, 'utf-8')
    } catch (error) {
      // Silently fail to avoid disrupting indexing
      console.warn('Failed to write progress log:', error)
    }
  }

  getLogFilePath(): string {
    return this.logFilePath
  }
}
