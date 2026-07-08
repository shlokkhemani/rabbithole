# HTML Frontend Layout

The Rabbithole page is served as one self-contained HTML document. Static shell
and CSS live as pure template strings here, while Node-only assembly lives under
`src/node/html/`.

- `styles.js` contains the inline stylesheet.
- `shell.js` contains the static DOM shell.
- `src/node/html/canvas.js` assembles the document and owns the public
  `buildCanvasHtml(...)` API for the MCP host.
- `src/node/html/built-assets.js` reads committed files from `dist/`:
  `client.js`, `frozen-client.js`, `katex.css`, and `dompurify.js`.
- `src/web/` is the standalone static web host. `npm run build` writes
  `web/dist/` (ignored) with `index.html`, `app.js`, CSS, DOMPurify, and frozen
  snapshot source. `scripts/check-dist.mjs` intentionally compares only the
  committed MCP `dist/` artifacts.
- `src/ui/*.js` are the browser runtime source modules. Edit those, then run
  `npm run build` and commit the resulting `dist/` changes.
- Hydration and SSE carry node markdown, not rendered HTML. The browser renders
  through `src/core/markdown-renderer.js`, with host adapters for UTF-8 base64
  and `asset:` URL resolution.
- Persisted holes are versioned in `src/core/schema.js`, storage goes through
  the `RabbitholeStore` port in `src/core/store.js`, and the filesystem
  implementation is `src/node/fs-store.js`.
- Node-tree mutations shared by hosts live in `src/core/reducer.js`; the MCP
  session in `src/node/transport/session.js` handles HTTP/SSE and agent
  orchestration around that reducer.
- The web host injects a direct in-page transport adapter instead of HTTP/SSE:
  browser events go to `DirectRabbitholeHost`, which applies the core reducer,
  persists through `IdbStore`, and streams Brain events back into the same UI
  `handleServer(...)` path.
- Streaming uses full-markdown-so-far `node_progress.markdown` payloads. The
  client coalesces stream renders to `requestAnimationFrame`, which keeps replay
  and reconnect logic simple while preserving existing scroll positions.
- The share menu's Download snapshot flow is client-generated: it serializes the
  current markdown state, fetches referenced `asset:` files as data URIs, and
  writes a frozen single-file HTML using `dist/frozen-client.js`. The `/export`
  route remains a compatibility shim that packages the same frozen hydration
  shape server-side.

Behavior-preserving rules:

- The served page and `/export` must stay single-file HTML with no external
  asset requests.
- Frozen exports must not include live transport wiring (`EventSource` or
  `/sse`) or live asset route strings.
- Do not read browser vendor assets from `node_modules` at runtime; vendor
  sources are inlined into `dist/` by `build.mjs`.
- Verify final HTML by extracting the single inline `<script>` and running
  `node --check` on that extracted script.
- `npm run check:dist` must pass before changes land so `dist/` stays fresh.

Web CSP:

- `web/dist/index.html` sets `default-src 'self'`, keeps scripts self-only, allows
  inline styles for the existing canvas runtime's dynamic positioning/sizing, and
  pins `connect-src` to the
  built-in BYOK providers plus localhost custom endpoints:
  OpenRouter, OpenAI, Anthropic, `localhost`, and `127.0.0.1`.
- Remote custom providers are deliberately not wildcarded. To use one from the
  static app, edit the generated CSP (or rebuild with that origin added). This
  keeps the default shipped app from allowing arbitrary key-bearing requests.
