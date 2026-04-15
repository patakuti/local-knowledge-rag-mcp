import { loadEmbeddingConfigFromEnv } from '../core/embedding-config-loader'

describe('loadEmbeddingConfigFromEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Reset to clean env for each test
    process.env = { ...originalEnv }
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_COMPATIBLE_API_KEY
    delete process.env.OPENAI_COMPATIBLE_BASE_URL
    delete process.env.OLLAMA_BASE_URL
    delete process.env.EMBEDDING_MODEL
    delete process.env.EMBEDDING_QUERY_PREFIX
    delete process.env.EMBEDDING_DOCUMENT_PREFIX
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('throws when no provider is configured', () => {
    expect(() => loadEmbeddingConfigFromEnv()).toThrow('No embedding provider configuration found')
  })

  describe('OpenAI provider', () => {
    it('selects openai when OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.provider).toBe('openai')
      expect(config.apiKey).toBe('sk-test')
      expect(config.model).toBe('openai-text-embedding-3-small')
    })

    it('uses custom model when EMBEDDING_MODEL is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test'
      process.env.EMBEDDING_MODEL = 'custom-model'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.model).toBe('custom-model')
    })
  })

  describe('OpenAI-compatible provider', () => {
    it('selects openai-compatible when OPENAI_COMPATIBLE_API_KEY is set', () => {
      process.env.OPENAI_COMPATIBLE_API_KEY = 'compat-key'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.provider).toBe('openai-compatible')
      expect(config.apiKey).toBe('compat-key')
      expect(config.baseUrl).toBe('http://localhost:4000/v1')
    })

    it('uses custom base URL when OPENAI_COMPATIBLE_BASE_URL is set', () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://myserver:8080/v1'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.provider).toBe('openai-compatible')
      expect(config.baseUrl).toBe('http://myserver:8080/v1')
    })

    it('takes priority over openai when both are set', () => {
      process.env.OPENAI_API_KEY = 'sk-test'
      process.env.OPENAI_COMPATIBLE_API_KEY = 'compat-key'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.provider).toBe('openai-compatible')
    })
  })

  describe('Ollama provider', () => {
    it('selects ollama when OLLAMA_BASE_URL is set', () => {
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434'

      const config = loadEmbeddingConfigFromEnv()
      expect(config.provider).toBe('ollama')
      expect(config.model).toBe('ollama-nomic-embed-text')
      expect(config.baseUrl).toBe('http://localhost:11434')
    })
  })

  describe('prefix support', () => {
    it('includes query and document prefixes when set', () => {
      process.env.OPENAI_API_KEY = 'sk-test'
      process.env.EMBEDDING_QUERY_PREFIX = 'search_query: '
      process.env.EMBEDDING_DOCUMENT_PREFIX = 'search_document: '

      const config = loadEmbeddingConfigFromEnv()
      expect(config.queryPrefix).toBe('search_query: ')
      expect(config.documentPrefix).toBe('search_document: ')
    })
  })
})
