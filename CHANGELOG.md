# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-11-16

### Added

- Local Knowledge RAG MCP Server - semantic search and report generation for knowledge bases
- Support for OpenAI, Ollama, and OpenAI-compatible embedding providers
- Semantic search with vector embeddings (`search_knowledge`)
- Session-based search result management
- Template-driven report generation (`create_rag_report`)
- Customizable report templates with variable substitution
- Environment variable `RAG_REPORT_OUTPUT_DIR` to configure report output directory
- Comprehensive documentation and examples
- MIT License
- Security guidelines for API key management

### Features

- Multiple embedding provider support (OpenAI, Ollama, OpenAI-compatible)
- Session-based search history and result management
- Template system for flexible report generation
- Resource safety limits (template size, array size constraints)
- Comprehensive error handling and logging
- Safe environment variable configuration with `.env.example`
