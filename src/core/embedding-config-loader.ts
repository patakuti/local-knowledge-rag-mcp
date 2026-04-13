/**
 * Embedding configuration for a workspace
 */
export interface EmbeddingConfig {
  provider: 'openai' | 'ollama' | 'openai-compatible'
  model: string
  apiKey?: string
  baseUrl?: string
  queryPrefix?: string
  documentPrefix?: string
}

/**
 * Load embedding configuration from environment variables
 *
 * @returns Embedding configuration
 * @throws Error if no valid configuration is found
 */
export function loadEmbeddingConfigFromEnv(): EmbeddingConfig {
  const openaiKey = process.env.OPENAI_API_KEY
  const openaiCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY
  const openaiCompatibleUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
  const ollamaUrl = process.env.OLLAMA_BASE_URL
  const embeddingModel = process.env.EMBEDDING_MODEL
  const queryPrefix = process.env.EMBEDDING_QUERY_PREFIX
  const documentPrefix = process.env.EMBEDDING_DOCUMENT_PREFIX

  // Determine provider and configuration
  if (openaiCompatibleKey || openaiCompatibleUrl) {
    const provider = 'openai-compatible'
    const defaultModel = 'openai-compatible-text-embedding-3-small'
    return {
      provider,
      model: embeddingModel || defaultModel,
      apiKey: openaiCompatibleKey,
      baseUrl: openaiCompatibleUrl || 'http://localhost:4000/v1',
      queryPrefix,
      documentPrefix,
    }
  } else if (openaiKey) {
    const provider = 'openai'
    const defaultModel = 'openai-text-embedding-3-small'
    return {
      provider,
      model: embeddingModel || defaultModel,
      apiKey: openaiKey,
      queryPrefix,
      documentPrefix,
    }
  } else if (ollamaUrl) {
    const provider = 'ollama'
    const defaultModel = 'ollama-nomic-embed-text'
    return {
      provider,
      model: embeddingModel || defaultModel,
      baseUrl: ollamaUrl,
      queryPrefix,
      documentPrefix,
    }
  } else {
    throw new Error(
      'No embedding provider configuration found. ' +
      'Please set one of: OPENAI_API_KEY, OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL, or OLLAMA_BASE_URL'
    )
  }
}
