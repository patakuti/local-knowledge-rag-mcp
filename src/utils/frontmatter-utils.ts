import { parse as parseYaml } from 'yaml'

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

/** Accepts the same shapes frontmatter `tags:`/`tag:` values come in: an array, or a comma/space-separated string. */
function tagsFromYamlValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String)
  }
  if (typeof value === 'string') return value.split(/[,\s]+/)
  if (typeof value === 'number') return [String(value)]
  return []
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').normalize('NFKC').toLowerCase()
}

/**
 * Whether a document's frontmatter carries the reserved `obsolete` tag (via `tags:` or `tag:`).
 * This is the only tag value this project currently recognizes — not a general tagging system.
 */
export function hasObsoleteTag(data: Record<string, unknown> | null): boolean {
  if (!data) return false
  for (const key of ['tags', 'tag']) {
    for (const raw of tagsFromYamlValue(data[key])) {
      if (normalizeTag(raw) === 'obsolete') return true
    }
  }
  return false
}
