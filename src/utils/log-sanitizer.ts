/**
 * Utilities for sanitizing sensitive information in logs
 *
 * These functions help prevent leaking:
 * - User home directory paths
 * - Absolute file paths containing usernames
 * - User query contents (which may contain secrets)
 * - URLs with authentication credentials
 */

import * as path from 'path'
import * as os from 'os'

/**
 * Sanitize file path for logging by converting to workspace-relative path
 *
 * @param absolutePath - Absolute file path
 * @param workspaceRoot - Workspace root directory
 * @returns Sanitized relative path safe for logging
 *
 * @example
 * sanitizePath('/home/user/project/src/file.ts', '/home/user/project')
 * // Returns: 'src/file.ts'
 *
 * sanitizePath('/home/user/other/file.ts', '/home/user/project')
 * // Returns: '<outside-workspace>/file.ts'
 */
export function sanitizePath(absolutePath: string, workspaceRoot: string): string {
  try {
    const relativePath = path.relative(workspaceRoot, absolutePath)

    // If path starts with ../, it's outside workspace
    if (relativePath.startsWith('..')) {
      return `<outside-workspace>/${path.basename(absolutePath)}`
    }

    return relativePath
  } catch (error) {
    // Fallback to basename only if path operations fail
    return `<error>/${path.basename(absolutePath)}`
  }
}

/**
 * Sanitize multiple file paths for logging
 *
 * @param paths - Array of absolute file paths
 * @param workspaceRoot - Workspace root directory
 * @returns Array of sanitized paths
 */
export function sanitizePaths(paths: string[], workspaceRoot: string): string[] {
  return paths.map(p => sanitizePath(p, workspaceRoot))
}

/**
 * Sanitize file path generically by replacing home directory
 * Use this when workspace root is not available
 *
 * @param filePath - File path (absolute or relative)
 * @returns Sanitized path with home directory replaced by ~
 *
 * @example
 * sanitizePathGeneric('/home/user/project/file.ts')
 * // Returns: '~/project/file.ts'
 */
export function sanitizePathGeneric(filePath: string): string {
  try {
    const homeDir = os.homedir()
    if (filePath.startsWith(homeDir)) {
      return '~' + filePath.substring(homeDir.length)
    }
    return filePath
  } catch (error) {
    return filePath
  }
}

/**
 * Sanitize user query for logging by truncating and showing length
 *
 * @param query - User search query
 * @param maxLength - Maximum characters to show (default: 20)
 * @returns Sanitized query safe for logging
 *
 * @example
 * sanitizeQuery('hello world')
 * // Returns: 'hello world'
 *
 * sanitizeQuery('this is a very long query with secrets', 20)
 * // Returns: 'this is a very long... (39 chars)'
 */
export function sanitizeQuery(query: string, maxLength: number = 20): string {
  if (query.length <= maxLength) {
    return query
  }

  return `${query.substring(0, maxLength)}... (${query.length} chars)`
}

/**
 * Sanitize URL for logging by removing credentials and sensitive parts
 *
 * @param url - URL string to sanitize (optional)
 * @returns Sanitized URL containing only protocol, host, and port
 *
 * @example
 * sanitizeUrl('https://api.example.com:8080/path?key=secret')
 * // Returns: 'https://api.example.com:8080'
 *
 * sanitizeUrl('https://user:pass@api.example.com/path')
 * // Returns: 'https://api.example.com'
 *
 * sanitizeUrl(undefined)
 * // Returns: '<not-set>'
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) {
    return '<not-set>'
  }

  try {
    const parsed = new URL(url)
    // Return only protocol + host (which includes port if present)
    // This removes username, password, path, query, and hash
    return `${parsed.protocol}//${parsed.host}`
  } catch (error) {
    return '<invalid-url>'
  }
}
