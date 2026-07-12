# Notes for agents working in this repo

If you were sent here to **install** Rabbithole for a user, stop — you don't
need to clone or build anything. Follow the Quick start in [README.md](./README.md)
(one `claude mcp add` / `codex mcp add` line). This file is for agents
**developing** the repo.

## What this is

An MCP server (stdio) that opens a branching-document canvas in the browser.
Plain ES modules, a small esbuild-based browser build, and script-driven tests.

- `bin/mcp-server.js` — entry; just imports `src/node/mcp/server.js`
- `src/core/` — host-independent document engine, renderer, artifacts, and
  contracts
- `src/ui/` — browser runtime shared by live pages and frozen snapshots
- `src/node/` — MCP wiring (server name `rabbithole`), filesystem storage,
  sessions, local HTTP/SSE transport, and Node PDF ingestion
- `src/web/` — static BYOK browser host, provider adapters, and IndexedDB store
- `src/core/html/` — shared self-contained shell, tokens, and stylesheet source
- `dist/` — committed live and frozen UI bundles; regenerate after UI changes
- `test/` — capability-oriented suites documented in `docs/testing.md`
- `website/public/` — live public assets copied by `build:publish`

## Run / debug

```bash
npm install
RABBITHOLE_NO_BROWSER=1 node bin/mcp-server.js   # speaks MCP on stdio
npm run build                                    # regenerate committed bundles
npm test                                         # deterministic default suite
```

Storage is JSON files under `~/.rabbithole/` (`RABBITHOLE_DIR` overrides).
Logs go to stderr — stdout is reserved for the MCP protocol; never print to
stdout.

## Conventions

- The product name is **Rabbithole** — one word, no space, in all copy.
- Node ≥ 18, ES modules everywhere.
- The canvas page must stay fully self-contained (one HTML response, no
  external assets) — that constraint is load-bearing for export/snapshots.
- stdout is reserved for MCP protocol messages; application logs go to stderr.
- Preserve old `.rabbithole` files and snapshots according to
  `docs/compatibility.md`; future formats must fail clearly rather than truncate.
