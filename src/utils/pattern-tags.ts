import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import { minimatch } from 'minimatch'
import { tagsFromYamlValue, normalizeTag, isObsoleteTag } from './tag-utils.js'

/**
 * Workspace-root config file mapping glob patterns to tags (shared filename/schema with the
 * sibling lkrag-lite project's tag feature). This project only gives meaning to the reserved
 * `obsolete` value; other tags are parsed but otherwise ignored.
 */
export const PATTERN_TAGS_FILENAME = '.lkragtags.yml'

export interface PatternTagRule {
  pattern: string
  tags: string[]
}

/**
 * Load and validate `.lkragtags.yml` from the workspace root. Missing file, malformed YAML, or a
 * non-mapping top level all return `[]` (logged, not thrown) so a bad config file never breaks
 * indexing. Individual invalid entries (empty pattern, no valid tags) are skipped with a warning
 * rather than invalidating the whole file.
 */
export function loadPatternTagRules(workspacePath: string): PatternTagRule[] {
  const filePath = path.join(workspacePath, PATTERN_TAGS_FILENAME)
  if (!fs.existsSync(filePath)) return []

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(`[pattern-tags] Failed to read ${PATTERN_TAGS_FILENAME}:`, error)
    return []
  }

  let data: unknown
  try {
    data = parseYaml(raw)
  } catch (error) {
    console.error(`[pattern-tags] Failed to parse ${PATTERN_TAGS_FILENAME}:`, error)
    return []
  }

  if (data === null || data === undefined) return []
  if (typeof data !== 'object' || Array.isArray(data)) {
    console.error(`[pattern-tags] ${PATTERN_TAGS_FILENAME} must be a mapping of glob pattern to tags, ignoring`)
    return []
  }

  const rules: PatternTagRule[] = []
  for (const [rawPattern, rawValue] of Object.entries(data as Record<string, unknown>)) {
    const pattern = rawPattern.trim()
    if (pattern.length === 0) {
      console.error(`[pattern-tags] ${PATTERN_TAGS_FILENAME}: skipping entry with an empty pattern`)
      continue
    }

    const tags = tagsFromYamlValue(rawValue).map(normalizeTag).filter((t) => t.length > 0)
    if (tags.length === 0) {
      console.error(`[pattern-tags] ${PATTERN_TAGS_FILENAME}: pattern "${pattern}" has no valid tags, skipping`)
      continue
    }

    rules.push({ pattern, tags })
  }

  return rules
}

/** Union of tags from every rule whose pattern matches `relPath` (workspace-relative, forward-slash). */
export function tagsForPath(relPath: string, rules: PatternTagRule[]): string[] {
  const tags = new Set<string>()
  for (const rule of rules) {
    if (minimatch(relPath, rule.pattern, { dot: true })) {
      for (const t of rule.tags) tags.add(t)
    }
  }
  return [...tags]
}

export function isObsoleteByPatterns(relPath: string, rules: PatternTagRule[]): boolean {
  return isObsoleteTag(tagsForPath(relPath, rules))
}
