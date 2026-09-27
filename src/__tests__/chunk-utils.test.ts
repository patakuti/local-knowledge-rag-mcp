import { TextChunker } from '../utils/chunk-utils'

describe('TextChunker obsolete flag propagation', () => {
  const chunker = new TextChunker({
    chunkSize: 50,
    chunkOverlap: 0,
    language: 'markdown',
    excludeCodeLanguages: [],
  })

  it('stamps every chunk of an obsolete file with metadata.obsolete = true', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: some text here`).join('\n')
    const chunks = await chunker.createChunks(content, 'doc.md', Date.now(), true)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.metadata.obsolete).toBe(true)
    }
  })

  it('leaves metadata.obsolete unset for a non-obsolete file', async () => {
    const content = 'a short document'
    const chunks = await chunker.createChunks(content, 'doc.md', Date.now())

    for (const chunk of chunks) {
      expect(chunk.metadata.obsolete).toBeUndefined()
    }
  })

  it('propagates the flag per-file through createChunksForFiles', async () => {
    const now = Date.now()
    const chunks = await chunker.createChunksForFiles([
      { path: 'a.md', content: 'file a content', mtime: now, obsolete: true },
      { path: 'b.md', content: 'file b content', mtime: now },
    ])

    const aChunks = chunks.filter((c) => c.path === 'a.md')
    const bChunks = chunks.filter((c) => c.path === 'b.md')

    expect(aChunks.every((c) => c.metadata.obsolete === true)).toBe(true)
    expect(bChunks.every((c) => c.metadata.obsolete === undefined)).toBe(true)
  })
})
