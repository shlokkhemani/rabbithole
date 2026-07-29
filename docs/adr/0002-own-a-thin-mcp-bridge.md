# ADR 0002: Own a thin MCP bridge

- Status: Accepted
- Date: 2026-07-28

## Context

Pi intentionally does not include an MCP client. Public Pi MCP adapters demonstrate useful proxy-tool and lifecycle patterns, but the most capable adapter also includes OAuth, native keyring support, MCP UI, sampling, elicitation, host-config imports, and other surfaces Nora does not require.

Nora must support MCP tools and resources over stdio and Streamable HTTP. Authentication and trust for corporate-source MCP servers belong to the user and the server, not to Nora.

## Decision

Nora builds a small bridge on the official `@modelcontextprotocol/sdk` and exposes it to Pi through custom tools.

The bridge provides:

- one compact proxy tool for MCP search, description, and invocation;
- an optional small direct-tool allowlist;
- lazy connections, cancellation, timeouts, bounded reconnects, list-change refresh, and clean shutdown;
- bounded and redacted diagnostic output;
- a shared extension-owned supervisor for open Nora documents.

The bridge reads `.vscode/mcp.json` and does not import unrelated host-specific MCP configuration.

Nora does not authenticate third-party sources, infer MCP tool side effects, add an MCP approval layer, or enforce read-only MCP execution. Users are responsible for the MCP servers and skills they configure.

## Consequences

- Nora avoids a large adapter dependency and excludes unneeded authentication and UI features.
- MCP behavior stays aligned with Nora's deliberately small product surface.
- The user, MCP server, and skill configuration form the security boundary for external systems.
- Pi remains read-only only for local code-research operations; configured MCP capabilities may have broader effects.

## Rejected Alternative

Adopting `pi-mcp-adapter` unchanged was rejected because its broader feature set and native keyring dependency conflict with Nora's minimal scope and credential boundary.
