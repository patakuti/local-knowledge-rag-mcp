import OpenAI from 'openai'
import type {
  EmbeddingModelClient,
  EmbeddingModelConfig,
  ProviderType
} from '../types/rag.types.js'
import { EmbeddingError } from '../types/rag.types.js'
import { sanitizeUrl } from '../utils/log-sanitizer.js'

// Abstract base class for embedding clients
export abstract class BaseEmbeddingClient implements EmbeddingModelClient {
  abstract readonly id: string
  abstract readonly dimension: number
  abstract getEmbedding(text: string): Promise<number[]>
}

// OpenAI Embedding Client
export class OpenAIEmbeddingClient extends BaseEmbeddingClient {
  private client: OpenAI

  constructor(private config: EmbeddingModelConfig) {
    super()

    if (!config.apiKey) {
      throw new Error('OpenAI API key is required')
    }

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl
    })
  }

  get id(): string {
    return this.config.model
  }

  get dimension(): number {
    return this.config.dimension
  }

  async getEmbedding(text: string): Promise<number[]> {
    if (!this.client.apiKey) {
      throw new EmbeddingError(
        'OpenAI API key is missing. Please set it in configuration.',
        'openai'
      )
    }

    try {
      const embedding = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
      })
      return embedding.data[0].embedding
    } catch (error: any) {
      if (error.status === 401) {
        throw new EmbeddingError(
          'OpenAI API key is invalid. Please update it in configuration.',
          'openai'
        )
      }
      if (error.status === 429) {
        throw new EmbeddingError(
          'OpenAI API rate limit exceeded. Please try again later.',
          'openai'
        )
      }
      throw new EmbeddingError(
        `OpenAI embedding failed: ${error.message}`,
        'openai'
      )
    }
  }
}

// OpenAI-compatible Embedding Client (e.g., LiteLLM, Azure OpenAI, local LLMs)
export class OpenAICompatibleEmbeddingClient extends BaseEmbeddingClient {
  private client: OpenAI

  constructor(private config: EmbeddingModelConfig) {
    super()

    if (!config.apiKey) {
      throw new Error('OpenAI-compatible API key is required')
    }

    const baseUrl = config.baseUrl || 'http://localhost:4000/v1'
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: baseUrl
    })
  }

  get id(): string {
    return this.config.model
  }

  get dimension(): number {
    return this.config.dimension
  }

  async getEmbedding(text: string): Promise<number[]> {
    try {
      const embedding = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
      })

      const embeddingVector = embedding.data[0].embedding

      // Update dimension if it differs from expected
      if (embeddingVector.length !== this.config.dimension) {
        console.error(`Model ${this.config.model} returned ${embeddingVector.length} dimensions, expected ${this.config.dimension}`)
        // Update the dimension for future reference
        this.config.dimension = embeddingVector.length
      }

      return embeddingVector
    } catch (error: any) {
      if (error.status === 401) {
        throw new EmbeddingError(
          'OpenAI-compatible API key is invalid. Please update it in configuration.',
          'openai-compatible'
        )
      }
      if (error.status === 429) {
        throw new EmbeddingError(
          'OpenAI-compatible API rate limit exceeded. Please try again later.',
          'openai-compatible'
        )
      }
      throw new EmbeddingError(
        `OpenAI-compatible embedding failed: ${error.message}. Check if model "${this.config.model}" is available on your server.`,
        'openai-compatible'
      )
    }
  }
}

// Ollama Embedding Client
export class OllamaEmbeddingClient extends BaseEmbeddingClient {
  private client: OpenAI

  constructor(private config: EmbeddingModelConfig) {
    super()

    const baseUrl = config.baseUrl || 'http://localhost:11434/v1'
    this.client = new OpenAI({
      apiKey: 'ollama', // Ollama doesn't use API keys
      baseURL: baseUrl
    })
  }

  get id(): string {
    return this.config.model
  }

  get dimension(): number {
    return this.config.dimension
  }

  async getEmbedding(text: string): Promise<number[]> {
    try {
      const embedding = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
        encoding_format: 'float',
      })
      return embedding.data[0].embedding
    } catch (error: any) {
      throw new EmbeddingError(
        `Ollama embedding failed: ${error.message}`,
        'ollama'
      )
    }
  }
}

// Factory function to create embedding clients
export function createEmbeddingClient(config: EmbeddingModelConfig): EmbeddingModelClient {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingClient(config)
    case 'openai-compatible':
      return new OpenAICompatibleEmbeddingClient(config)
    case 'ollama':
      return new OllamaEmbeddingClient(config)
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`)
  }
}

// Default embedding model configurations
export const DEFAULT_EMBEDDING_CONFIGS: Record<string, EmbeddingModelConfig> = {
  'openai-text-embedding-3-small': {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimension: 1536
  },
  'openai-text-embedding-3-large': {
    provider: 'openai',
    model: 'text-embedding-3-large',
    dimension: 3072
  },
  'openai-compatible-text-embedding-3-small': {
    provider: 'openai-compatible',
    model: 'text-embedding-3-small',
    dimension: 1536,
    baseUrl: 'http://localhost:4000/v1'
  },
  'openai-compatible-text-embedding-ada-002': {
    provider: 'openai-compatible',
    model: 'text-embedding-ada-002',
    dimension: 1536,
    baseUrl: 'http://localhost:4000/v1'
  },
  'ollama-nomic-embed-text': {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimension: 768,
    baseUrl: 'http://localhost:11434/v1'
  }
}

// Get embedding model config with API key injection
export function getEmbeddingModelConfig(
  modelId: string,
  apiKey?: string,
  baseUrl?: string
): EmbeddingModelConfig {
  const config = DEFAULT_EMBEDDING_CONFIGS[modelId]

  if (config) {
    // Use predefined config
    return {
      ...config,
      apiKey: apiKey || config.apiKey,
      baseUrl: baseUrl || config.baseUrl
    }
  }

  // For custom models, infer provider from environment and model name
  let provider: ProviderType = 'openai' // default
  let dimension = 1536 // default dimension
  let inferredBaseUrl = baseUrl

  // Auto-detect provider based on environment variables and model patterns
  if (baseUrl?.includes('ollama') || process.env.OLLAMA_BASE_URL) {
    provider = 'ollama'
    dimension = 768 // common for ollama models
    inferredBaseUrl = baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'
  } else if (baseUrl?.includes('4000') || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OPENAI_COMPATIBLE_API_KEY) {
    provider = 'openai-compatible'
    inferredBaseUrl = baseUrl || process.env.OPENAI_COMPATIBLE_BASE_URL || 'http://localhost:4000/v1'
  }

  // For Japanese/multilingual models, use common dimensions
  if (modelId.includes('ruri') || modelId.includes('japanese') || modelId.includes('multilingual')) {
    dimension = 768 // Common for smaller multilingual models
  }

  console.error(`Creating custom embedding config for: ${modelId}`)
  console.error(`Detected provider: ${provider}, dimension: ${dimension}, baseUrl: ${sanitizeUrl(inferredBaseUrl)}`)

  return {
    provider,
    model: modelId,
    apiKey: apiKey || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: inferredBaseUrl,
    dimension
  }
}