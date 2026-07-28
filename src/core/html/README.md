# HTML Frontend Layout

The Nora canvas shell and stylesheet live here as host-independent template
strings. The VS Code extension assembles the editable webview in
`src/extension/webview-html.js`, while `src/core/snapshot-html.js` assembles
read-only frozen snapshots.

- `styles.js` contains the canvas stylesheet source.
- `shell.js` contains the static DOM shell.
- `src/ui/*.js` are the browser runtime source modules shared by the webview
  and frozen snapshot client.
- `scripts/build-nora.mjs` writes ignored `out/webview/` assets: the Nora
  webview entry, frozen client, CSS, DOMPurify, KaTeX CSS, Mermaid, PDF.js,
  standard fonts, CMaps, and approved Pi/Photon runtime assets.
- Hydration carries node markdown, not rendered HTML. The browser renders
  through `src/core/markdown-renderer.js`, with host adapters for UTF-8 base64
  and `asset:` URL resolution.
- Nora documents are versioned in `src/core/document-schema.js` and persisted
  as `.nora` ZIP archives by `src/extension/archive/`.
- Node-tree mutations shared by hosts live in `src/core/document-state.js`; it
  delegates legacy-compatible renderer events to `src/core/reducer.js` during
  the migration.
- The VS Code webview posts validated messages through the extension protocol
  instead of HTTP/SSE.
- Streaming uses full-markdown-so-far `node_progress.markdown` payloads. The
  client coalesces stream renders to `requestAnimationFrame`, which keeps replay
  simple while preserving existing scroll positions.
- Snapshot export serializes a sanitized Nora snapshot projection, embeds only
  referenced assets, and runs the frozen client from `out/webview/frozen-client.js`.

Behavior-preserving rules:

- The editable VS Code webview must load only extension-owned local resources
  allowed by its CSP and `localResourceRoots`.
- Frozen snapshots must stay self-contained, inert, and read-only.
- Frozen snapshots include the inert Mermaid/PDF runtime carriers only when the
  projected document needs them.
- Frozen exports must not include live transport wiring (`EventSource` or
  `/sse`) or old host route strings.
- Do not read browser vendor assets from `node_modules` at runtime; build
  scripts copy approved sources into `out/`.
- `npm run check:build` and `npm run check:native` must pass before changes land
  so the Nora bundle is reproducible and native-runtime-free.
