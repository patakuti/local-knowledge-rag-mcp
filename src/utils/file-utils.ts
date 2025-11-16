import { readFile, stat, access } from 'fs/promises'
import { glob } from 'glob'
import { minimatch } from 'minimatch'
import path from 'path'
import type { FileInfo } from '../types/rag.types.js'

export class FileSystemUtils {
  constructor(private workspacePath: string) {}

  /**
   * Get all files matching include patterns and excluding exclude patterns
   */
  async getFilesToIndex(options: {
    includePatterns: string[]
    excludePatterns: string[]
  }): Promise<FileInfo[]> {
    const { includePatterns, excludePatterns } = options

    // Use glob to find files matching include patterns
    const allFiles: string[] = []

    for (const pattern of includePatterns) {
      const files = await glob(pattern, {
        cwd: this.workspacePath,
        nodir: true, // Only files, not directories
        dot: false, // Don't include hidden files by default
      })
      allFiles.push(...files)
    }

    // Remove duplicates
    const uniqueFiles = [...new Set(allFiles)]

    // Filter out excluded files
    const filteredFiles = uniqueFiles.filter(filePath => {
      return !excludePatterns.some(pattern =>
        minimatch(filePath, pattern, { dot: true })
      )
    })

    // Get file stats
    const fileInfos: FileInfo[] = []
    for (const filePath of filteredFiles) {
      try {
        const fullPath = path.join(this.workspacePath, filePath)
        const fileStat = await stat(fullPath)

        if (fileStat.isFile()) {
          fileInfos.push({
            path: filePath,
            stat: {
              mtime: fileStat.mtime.getTime(),
              size: fileStat.size
            }
          })
        }
      } catch (error) {
        // Skip files that can't be accessed
        console.warn(`Cannot access file ${filePath}:`, error)
      }
    }

    return fileInfos
  }

  /**
   * Get all file paths matching include patterns and excluding exclude patterns
   */
  async getAllFiles(includePatterns: string[], excludePatterns: string[]): Promise<string[]> {
    // Use glob to find files matching include patterns
    const allFiles: string[] = []

    for (const pattern of includePatterns) {
      const files = await glob(pattern, {
        cwd: this.workspacePath,
        nodir: true, // Only files, not directories
        dot: false, // Don't include hidden files by default
      })
      allFiles.push(...files)
    }

    // Remove duplicates
    const uniqueFiles = [...new Set(allFiles)]

    // Filter out excluded files
    const filteredFiles = uniqueFiles.filter(filePath => {
      return !excludePatterns.some(pattern =>
        minimatch(filePath, pattern, { dot: true })
      )
    })

    return filteredFiles
  }

  /**
   * Read file content as text
   */
  async readFileContent(filePath: string): Promise<string> {
    const fullPath = path.join(this.workspacePath, filePath)
    return await readFile(fullPath, 'utf-8')
  }

  /**
   * Check if file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.workspacePath, filePath)
      await access(fullPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get file modification time
   */
  async getFileModificationTime(filePath: string): Promise<number> {
    const fullPath = path.join(this.workspacePath, filePath)
    const fileStat = await stat(fullPath)
    return fileStat.mtime.getTime()
  }

  /**
   * Check which files from the list still exist
   */
  async filterExistingFiles(filePaths: string[]): Promise<string[]> {
    const existingFiles: string[] = []

    for (const filePath of filePaths) {
      if (await this.fileExists(filePath)) {
        existingFiles.push(filePath)
      }
    }

    return existingFiles
  }

  /**
   * Get files that need reindexing (modified or new)
   */
  async getFilesToReindex(
    allFiles: FileInfo[],
    indexedFiles: Map<string, number> // path -> mtime
  ): Promise<FileInfo[]> {
    return allFiles.filter(file => {
      // Skip empty files (size 0) - they will be skipped during processing anyway
      // and won't be indexed, so we shouldn't keep trying to reindex them
      if (file.stat.size === 0) {
        return false
      }

      const indexedMtime = indexedFiles.get(file.path)
      if (!indexedMtime) {
        // File not indexed yet
        return true
      }
      // File modified since last index
      return file.stat.mtime > indexedMtime
    })
  }

  /**
   * Sanitize file content (remove null bytes, etc.)
   */
  sanitizeContent(content: string): string {
    // Remove null bytes that can cause issues with text processing
    // eslint-disable-next-line no-control-regex
    return content.replace(/\x00/g, '')
  }

  /**
   * Filter files by scope (specific files or folders)
   */
  filterFilesByScope(
    files: FileInfo[],
    scope?: {
      files?: string[]
      folders?: string[]
    }
  ): FileInfo[] {
    if (!scope) {
      return files
    }

    return files.filter(file => {
      // Check if file is in the specific files list
      if (scope.files && scope.files.length > 0) {
        return scope.files.includes(file.path)
      }

      // Check if file is in any of the specified folders
      if (scope.folders && scope.folders.length > 0) {
        return scope.folders.some(folder =>
          file.path.startsWith(folder + '/') || file.path === folder
        )
      }

      return true
    })
  }

  /**
   * Get workspace relative path
   */
  getRelativePath(absolutePath: string): string {
    return path.relative(this.workspacePath, absolutePath)
  }

  /**
   * Get absolute path from workspace relative path
   */
  getAbsolutePath(relativePath: string): string {
    return path.resolve(this.workspacePath, relativePath)
  }
}

/**
 * Default file patterns for different types of projects
 */
export const DEFAULT_INCLUDE_PATTERNS = {
  documentation: ['*.md', '*.txt', '*.rst'],
  code: ['*.js', '*.ts', '*.tsx', '*.jsx', '*.py', '*.java', '*.cpp', '*.c', '*.h'],
  web: ['*.html', '*.css', '*.scss', '*.sass', '*.less'],
  config: ['*.json', '*.yaml', '*.yml', '*.toml', '*.ini'],
  all: [
    '*.md', '*.txt', '*.rst',
    '*.js', '*.ts', '*.tsx', '*.jsx',
    '*.py', '*.java', '*.cpp', '*.c', '*.h',
    '*.html', '*.css', '*.scss',
    '*.json', '*.yaml', '*.yml'
  ]
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.svn/**',
  '.hg/**',
  'dist/**',
  'build/**',
  'out/**',
  'target/**',
  '*.min.*',
  '*.bundle.*',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.cache',
  '__pycache__/**',
  '*.pyc',
  '.pytest_cache/**',
  'coverage/**',
  '.nyc_output/**'
]