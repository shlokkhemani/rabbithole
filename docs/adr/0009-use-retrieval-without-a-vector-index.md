# ADR 0009: Use retrieval without a vector index

- Status: Accepted
- Date: 2026-07-28

## Context

Nora researches arbitrary Git repositories and corporate sources. A built-in embedding pipeline or vector database would add indexing lifecycle, storage, model dependencies, corporate-data routing decisions, and another persistence subsystem.

Pi already has read-only file discovery and text-search tools, while corporate systems are exposed through user-configured MCP servers and skills.

## Decision

Nora does not build embeddings, a vector database, or a persistent semantic index.

- Code retrieval uses read-only Pi tools over Nora-acquired Git worktrees.
- Corporate-source retrieval uses MCP tools and resources.
- Skills may orchestrate those capabilities.

## Consequences

- Nora has no indexing setup, background synchronization, embedding cost, or vector-store credentials.
- Retrieval freshness follows the acquired Git revision and connected MCP source.
- Search quality depends on text search, Pi reasoning, MCP server capabilities, and installed skills.

## Rejected Alternative

A built-in semantic index was rejected because no confirmed requirement justifies its additional data, security, and lifecycle complexity.
