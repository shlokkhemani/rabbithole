# HTML Frontend Layout

The Rabbithole page is served as one self-contained HTML document. Static shell
and CSS still live as template strings here, while the browser runtime is now a
committed build artifact.

- `canvas.js` assembles the document and owns the public `buildCanvasHtml(...)`
  API.
- `styles.js` contains the inline stylesheet.
- `shell.js` contains the static DOM shell.
- `built-assets.js` reads committed files from `dist/`:
  `client.js`, `katex.css`, and `dompurify.js`.
- `src/ui/*.js` are the browser runtime source modules. Edit those, then run
  `npm run build` and commit the resulting `dist/` changes.

Behavior-preserving rules:

- The served page and `/export` must stay single-file HTML with no external
  asset requests.
- Do not read browser vendor assets from `node_modules` at runtime; vendor
  sources are inlined into `dist/` by `build.mjs`.
- Verify final HTML by extracting the single inline `<script>` and running
  `node --check` on that extracted script.
- `npm run check:dist` must pass before changes land so `dist/` stays fresh.
