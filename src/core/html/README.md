# HTML Frontend Layout

The Rabbithole page is served as one self-contained HTML document. Static shell
and CSS still live as template strings here, while the browser runtime is now a
committed build artifact.

- `canvas.js` assembles the document and owns the public `buildCanvasHtml(...)`
  API.
- `styles.js` contains the inline stylesheet.
- `shell.js` contains the static DOM shell.
- `built-assets.js` reads committed files from `dist/`:
  `client.js`, `frozen-client.js`, `katex.css`, and `dompurify.js`.
- `src/ui/*.js` are the browser runtime source modules. Edit those, then run
  `npm run build` and commit the resulting `dist/` changes.
- Hydration and SSE carry node markdown, not rendered HTML. The browser renders
  through `src/core/markdown-renderer.js`, with host adapters for UTF-8 base64
  and `asset:` URL resolution.
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
