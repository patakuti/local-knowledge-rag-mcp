import { parse as parseYaml } from 'yaml'
import { tagsFromYamlValue, isObsoleteTag } from './tag-utils.js'

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/**
 * Split a leading YAML frontmatter block off a document's content.
 * `body` has the frontmatter block removed so it never reaches embeddings/search,
 * with line numbers of the remainder otherwise unaffected (no re-indentation).
 */
export function parseFrontmatter(content: string): { data: Record<string, unknown> | null; body: string } {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return { data: null, body: content }

  let data: unknown
  try {
    data = parseYaml(match[1])
  } catch {
    return { data: null, body: content }
  }

  if (!data || typeof data !== 'object') return { data: null, body: content }
  return { data: data as Record<string, unknown>, body: content.slice(match[0].length) }
}

/**
 * Whether a document's frontmatter carries the reserved `obsolete` tag (via `tags:` or `tag:`).
 */
export function hasObsoleteTag(data: Record<string, unknown> | null): boolean {
  if (!data) return false
  const tags = [...tagsFromYamlValue(data.tags), ...tagsFromYamlValue(data.tag)]
  return isObsoleteTag(tags)
}
