/** Accepts the same shapes tag values come in across this project: an array, or a comma/space-separated string. */
export function tagsFromYamlValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String)
  }
  if (typeof value === 'string') return value.split(/[,\s]+/)
  if (typeof value === 'number') return [String(value)]
  return []
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').normalize('NFKC').toLowerCase()
}

/**
 * Whether a tag list carries the reserved `obsolete` value.
 * This is the only tag value this project currently recognizes — not a general tagging system.
 */
export function isObsoleteTag(tags: string[]): boolean {
  return tags.some((t) => normalizeTag(t) === 'obsolete')
}
