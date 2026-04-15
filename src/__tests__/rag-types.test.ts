import {
  embeddingModelConfigSchema,
  chunkingConfigSchema,
  searchConfigSchema,
  indexingConfigSchema,
  ragConfigSchema,
  reportConfigSchema,
  RAGError,
  EmbeddingError,
  IndexingError,
  SearchError,
} from '../types/rag.types'

describe('Zod schema validation', () => {
  describe('embeddingModelConfigSchema', () => {
    it('accepts valid config', () => {
      const result = embeddingModelConfigSchema.safeParse({
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: 1536,
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid provider', () => {
      const result = embeddingModelConfigSchema.safeParse({
        provider: 'invalid',
        model: 'test',
        dimension: 1536,
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing required fields', () => {
      const result = embeddingModelConfigSchema.safeParse({
        provider: 'openai',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('chunkingConfigSchema', () => {
    it('applies defaults', () => {
      const result = chunkingConfigSchema.parse({})
      expect(result.chunkSize).toBe(1000)
      expect(result.chunkOverlap).toBe(200)
      expect(result.language).toBe('markdown')
    })

    it('accepts overrides', () => {
      const result = chunkingConfigSchema.parse({
        chunkSize: 500,
        chunkOverlap: 100,
      })
      expect(result.chunkSize).toBe(500)
      expect(result.chunkOverlap).toBe(100)
    })
  })

  describe('searchConfigSchema', () => {
    it('applies defaults', () => {
      const result = searchConfigSchema.parse({})
      expect(result.minSimilarity).toBe(0.7)
      expect(result.maxResults).toBe(10)
      expect(result.maxChunksPerQuery).toBe(5)
    })
  })

  describe('indexingConfigSchema', () => {
    it('applies defaults for include/exclude patterns', () => {
      const result = indexingConfigSchema.parse({})
      expect(result.includePatterns).toEqual(expect.arrayContaining(['*.md']))
      expect(result.excludePatterns).toEqual(expect.arrayContaining(['node_modules/**']))
      expect(result.maxFileSizeKB).toBe(512)
    })

    it('rejects non-positive maxFileSizeKB', () => {
      const result = indexingConfigSchema.safeParse({ maxFileSizeKB: 0 })
      expect(result.success).toBe(false)
    })
  })

  describe('ragConfigSchema', () => {
    it('accepts a complete valid config', () => {
      const result = ragConfigSchema.safeParse({
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimension: 1536,
        },
        chunking: {},
        search: {},
        indexing: {},
      })
      expect(result.success).toBe(true)
    })

    it('rejects when embedding is missing', () => {
      const result = ragConfigSchema.safeParse({
        chunking: {},
        search: {},
        indexing: {},
      })
      expect(result.success).toBe(false)
    })
  })

  describe('reportConfigSchema', () => {
    it('applies defaults', () => {
      const result = reportConfigSchema.parse({})
      expect(result.maxQuoteLines).toBe(5)
      expect(result.removeBlankLines).toBe(true)
    })
  })
})

describe('Error types', () => {
  it('RAGError has code property', () => {
    const err = new RAGError('test', 'TEST_CODE')
    expect(err.message).toBe('test')
    expect(err.code).toBe('TEST_CODE')
    expect(err.name).toBe('RAGError')
    expect(err).toBeInstanceOf(Error)
  })

  it('EmbeddingError has provider property', () => {
    const err = new EmbeddingError('fail', 'openai')
    expect(err.provider).toBe('openai')
    expect(err.code).toBe('EMBEDDING_ERROR')
    expect(err).toBeInstanceOf(RAGError)
  })

  it('IndexingError sets correct code', () => {
    const err = new IndexingError('fail')
    expect(err.code).toBe('INDEXING_ERROR')
  })

  it('SearchError sets correct code', () => {
    const err = new SearchError('fail')
    expect(err.code).toBe('SEARCH_ERROR')
  })
})
