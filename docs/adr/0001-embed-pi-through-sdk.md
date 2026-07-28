# ADR 0001: Embed Pi through its SDK

- Status: Accepted
- Date: 2026-07-28

## Context

Nora is a Node.js/TypeScript VS Code extension. It needs to stream Pi events into a webview, expose canvas operations as agent tools, use read-only code-research tools, connect custom MCP tools, and support both subscription and API-token LLM providers.

Pi offers both an in-process SDK and a JSONL RPC protocol over a child process.

## Decision

Nora embeds `@earendil-works/pi-coding-agent` directly through its SDK in the VS Code extension host.

Nora does not implement, ship, or retain a JSON/RPC integration path.

## Consequences

- Pi sessions, model configuration, custom tools, and event streaming remain in one Node.js process.
- Canvas and MCP tools can call extension APIs directly.
- Nora does not need to package or supervise a Pi subprocess or maintain a JSONL bridge.
- A Pi failure can affect the extension host because there is no process-isolation boundary. This is accepted for the simpler product architecture.

## Rejected Alternative

JSON/RPC was rejected because Nora is already a supported Node.js host and has no confirmed isolation requirement. RPC would add subprocess packaging, protocol framing, restart handling, and a reverse bridge to VS Code-owned state.
