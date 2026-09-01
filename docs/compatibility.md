# Data and protocol contracts

Rabbithole currently has one canonical representation at every persistence
boundary. Inputs must match the current representation; the codebase does not
carry format-upgrade paths.

## Persisted holes

Filesystem and IndexedDB records use `schema_version: 2`. The runtime authority
is `src/core/schema.js`:

- `toPersistedHole` creates the canonical record written by either store.
- `parsePersistedHole` clones and validates untrusted records and normalizes the
  documented PDF selection rectangle.
- `validatePersistedHole` enforces the current document and node shape.

Missing, null, or unsupported schema versions are rejected. A version greater
than the current version fails with the explicit update-to-open message before
the record is mutated.

Persisted nodes contain Markdown source, base-URL provenance, origin metadata,
layout and read state, timestamps, and an `extensions` object. Rendered HTML is
derived and is never persisted.

### Markdown dialect

Rabbithole uses GFM with one deliberate ambiguity removed: strikethrough
requires double tildes (`~~deleted~~`). Single tildes remain literal so common
approximation notation such as `~77%`, `~zero`, and `~1,000` cannot pair across
an arbitrary span and silently render intervening prose as deleted. Escaped
tildes and tildes inside code retain their normal Markdown behavior.

This rule belongs to the shared renderer and therefore applies identically to
live canvases, browser documents, Node rendering, and newly generated frozen
snapshots. Markdown source is not rewritten.

## Portable files and snapshots

Portable `.rabbithole` files use this envelope:

```json
{
  "format": "rabbithole",
  "format_version": 1,
  "hole": { "schema_version": 2 },
  "assets": {}
}
```

Imports validate the envelope, size caps, asset names and bytes, and the current
hole schema before writing anything. Identity collisions receive a fresh hole
ID. Partial imports are removed if asset persistence fails.

Snapshot HTML is self-contained and carries the same portable envelope in one
inert `application/vnd.rabbithole+json` script element. Snapshot projection:

- includes only referenced assets;
- clears every node's personal `extensions` bag to `{}`;
- includes the shareable canvas view;
- contains no credentials, settings, live transport, or external assets.
- embeds the pinned Mermaid runtime only when a node contains a Mermaid fence,
  preserving offline diagram rendering without changing the portable payload.

The frozen client derives hydration exclusively from that portable payload.

## Browser storage

Browser documents live in the `rabbithole-browser` IndexedDB database. The
current stores are `holes`, `hole-summaries`, `assets`, `staging`, and `meta`.
Whimsical `hole_id` values are device-local URL locators, not network share
tokens.

Preferences use `rh-web-settings`. Remembered provider keys use the
`rh-web-api-keys` map; session-only keys remain in memory. Credentials and
preferences are separate from document storage and are excluded from portable
files, snapshots, MCP hydration, and stored holes.

## MCP surface

The server exposes `open_rabbithole`, `answer_branch`, `read_rabbithole`,
`send_to_rabbithole`, and `list_rabbitholes`. Tool inputs are validated and
capped before filesystem or session mutation. The browser transport uses the event vocabulary in
`src/core/contracts/engine.d.ts`; the agent loop receives branch requests,
conversion requests, and terminal session status. Branch requests carry a
compact tree-and-note map, add full note deltas, and include an undelivered
lineage thread when needed; saved pending asks remain ordinary branch requests.

Sub-agent protocol (`branch_request` only; never `convert_request`):

1. Sub-agents never call Rabbithole; the main agent is the sole coordinator.
2. After spawning a sub-agent, call `answer_branch` with exactly `{ session_id, request_id, delegated: true }`. It returns immediately; the card shows “Working in sub-agent…”. Pass the question and `selected_text` to the sub-agent yourself—it cannot fetch them.
3. Immediately restore the sole listener with `open_rabbithole { hole_id }`. Skip this only while an ordinary final `answer_branch` is still blocked: that call is the listener; `already_listening` confirms one is attached.
4. When the sub-agent returns, stream or finish the retained `request_id` normally, omitting `delegated`. Partials and the final all return immediately; delegated requests may finish in any order and never take the listener.
5. If the sub-agent fails or is abandoned, call `answer_branch` with exactly `{ session_id, request_id, delegated: false }` to reclaim it, then answer it yourself. It returns to ordinary Thinking and listener behavior.

Delegation is live coordination state: it survives canvas reload, not server restart.
It never enters persisted holes, portable files, or snapshots.

stdout is reserved for MCP protocol messages. Application logs always go to
stderr.

## Security and resource limits

Markdown source is authoritative. Live and frozen rendering share the same
sanitizing renderer, reject unsafe URLs, and keep imported HTML inert. Portable
imports enforce file, payload, node, asset-count, per-asset, and aggregate-byte
caps before decoding expensive data.

The contract suites covering these boundaries are:

- `test/contracts/data-boundaries.test.mjs`
- `test/contracts/artifact-roundtrip.test.mjs`
- `test/contracts/compatibility-security.test.mjs`
- `test/contracts/filesystem-store.test.mjs`
- `test/contracts/indexeddb-store.test.mjs`
- `test/contracts/mcp-markdown-wire.test.mjs`
- `test/e2e/cross-host-journey.test.mjs`

## Changing a format

Until Rabbithole makes a public backward-compatibility promise, a format change
should update the canonical schema, producers, consumers, fixtures, and docs in
one change. Do not add speculative upgrade code. Keep future-version refusal so
newer data can never be reconstructed lossily by an older binary.
