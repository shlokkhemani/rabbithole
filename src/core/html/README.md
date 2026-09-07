# HTML Frontend Layout

The Rabbithole page is served as one self-contained HTML document. Static shell
and CSS live as pure template strings here, while Node-only assembly lives under
`src/node/html/`.

- `../../design/index.canvas.css` is the authored stylesheet entry; the build
  emits `dist/canvas.css`, which the page assembler inlines.
- `shell.js` contains the static DOM shell.
- `icons.js` is the only product-facing icon registry. Curated Ionicons source
  is normalized into `ionicons5.generated.js` by `npm run generate:icons`; the
  generated data is committed so production installs never need the source pack.
- `icon-selection.js` is the editable role-to-icon map. Run
  `npm run icons:studio` and open `http://127.0.0.1:4178` to compare every
  Ionicons 5 glyph in the real light, dark, navigation, and control contexts.
  Draft choices remain local until **Apply to Rabbithole** regenerates the
  curated payload and ignored UI bundles.
- `src/node/html/canvas.js` assembles the document and owns the public
  `buildCanvasHtml(...)` API for the MCP host.
- `src/node/html/built-assets.js` reads built files from `dist/`: `client.js`,
  `frozen-client.js`, `canvas.css`, and `katex.css`. DOMPurify and Mermaid are
  resolved from their installed packages.
- `src/node/html/dev-reload.js` holds the `RABBITHOLE_DEV` loop: with it unset
  those reads stay frozen at first access, and with it set both the bundles and
  the `src/core/` template modules are re-read per page load so a browser reload
  shows a rebuild without restarting the MCP server.
- `src/web/` is the standalone static web host. `npm run build` writes
  `web/dist/` (ignored) with `index.html`, `app.js`, CSS, DOMPurify, Mermaid,
  and frozen snapshot source.
- `src/ui/*.js` are the browser runtime source modules. Edit those, then run
  `npm run build` to refresh both ignored build directories.
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
  route packages the same frozen projection server-side.

Behavior-preserving rules:

- The served page and `/export` must stay single-file HTML with no external
  asset requests.
- MCP pages carry Mermaid as inert script text and activate it only when a
  Mermaid fence mounts. Frozen snapshots include that carrier only when their
  Markdown contains a Mermaid fence; the hosted web app loads the same pinned
  file lazily from its own origin.
- Frozen exports must not include live transport wiring (`EventSource` or
  `/sse`) or live asset route strings.
- Browser bundles and styles are generated in ignored `dist/`; `prepare`
  supplies them for source installs and package creation. Large byte-identical
  vendor runtimes are resolved from declared package dependencies when the
  local host assembles a self-contained page.
- After changing the curated Ionicons set or its normalization, run
  `npm run generate:icons`. `npm run check:icons` guards against generated drift.
- Verify final HTML by extracting the executable inline `<script>` and running
  `node --check` on that extracted script.

Web CSP:

- `web/dist/index.html` sets `default-src 'self'`, keeps external scripts
  self-only, and permits one hash-pinned inline script that selects the saved or
  system theme before first paint. Inline styles remain allowed for the early
  theme background and the canvas runtime's dynamic positioning/sizing.
  `connect-src` permits HTTP and HTTPS because a user-selected custom provider
  can live at any origin. Script execution remains self-only, and provider
  credentials are sent only to the endpoint selected in browser settings.
- The fetch proxy uses a separate, narrow server-side hostname allowlist. Its
  SSRF boundary must never be replaced with the browser's broad connect list.
