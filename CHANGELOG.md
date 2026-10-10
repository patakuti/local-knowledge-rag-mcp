# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-10

First tagged release.

### Added

- MCP server for semantic search and report generation over local knowledge bases (`search_knowledge`, `create_rag_report`)
- Embedding providers: OpenAI, Ollama, and OpenAI-compatible APIs, with query/document prefix support for instruction-based models (ruri-v3, E5, etc.)
- PostgreSQL + pgvector storage with a per-workspace embeddings table and an independent HNSW index (per-query `hnsw.ef_search` tuning)
- Session-based search result management
- Template-driven report generation with customizable templates (including `paper` and `manual`), automatic line-range resolution, and relative-path file links
- Index Manager web UI (bound to 127.0.0.1, CORS restricted to localhost) with rebuild/update/cancel, pipelined embedding and batched SQL for large corpora
- `lkrag` command-line interface for search and index management (`--quiet`, `--find-workspace`, graceful Ctrl-C handling, automatic repair of a broken HNSW index)
- Obsolete tagging to exclude superseded documents from search, including directory/path-pattern rules via `.lkragtags.yml`
- Example integrations: Emacs and a minimal VS Code extension (`vscode-extension/`, not published to the Marketplace)
- Unit tests and GitHub Actions CI
- `RAG_REPORT_OUTPUT_DIR` environment variable to configure the report output directory
- MIT License and security guidelines for API key management

### Changed

- The MCP server now reports the version from `package.json` instead of a hardcoded value
