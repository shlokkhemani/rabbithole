# Contributing to Rabbithole

Thank you for helping make Rabbithole better. The project uses plain JavaScript
ES modules, Node 18 or newer, and browser-native APIs. There is no application
framework and no runtime build step for the MCP package.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing a public format, host
boundary, or UI composition. [Testing Rabbithole](docs/testing.md) documents the
test tiers and the contracts each suite protects.

## Set up a development checkout

```bash
git clone https://github.com/shlokkhemani/rabbithole.git
cd rabbithole
npm ci
npx playwright install chromium firefox webkit
```

Run the MCP server without opening a browser:

```bash
RABBITHOLE_NO_BROWSER=1 node bin/mcp-server.js
```

The process speaks MCP over standard input and output. Never write logs or debug
output to stdout; use the logger in `src/node/logger.js`, which writes to stderr.
Local documents are stored below `~/.rabbithole/` unless `RABBITHOLE_DIR` points
to a disposable development directory.

To build and serve the static web app locally:

```bash
npm run build
npx serve web/dist
```

Any static file server is suitable; `serve` is only an example and can be run
through `npx` without adding it to the project.

## Common commands

| Command | Purpose |
|---|---|
| `npm run build` | Rebuild committed MCP browser assets in `dist/` and the ignored static app in `web/dist/`. |
| `npm run check:dist` | Rebuild to a temporary directory and verify that committed `dist/` is current. |
| `npm run check:purity` | Enforce browser/core import boundaries. |
| `npm run check:types` | Run strict JavaScript checking over the typed core contracts and their fixtures. |
| `npm test` | Run unit, contract, integration, end-to-end, and performance suites. |
| `npm run test:unit` | Run fast model, renderer, content-block, and URL-resolution tests. |
| `npm run test:contracts` | Run persistence, artifact, MCP wire, security, compatibility, and relay-boundary tests. |
| `npm run test:integration` | Run host-level ingestion, generation, portability, image, and reattachment tests. |
| `npm run test:e2e` | Run real-browser product and cross-host journeys. |
| `npm run test:performance` | Check recorded size and timing ceilings. |
| `npm run test:packaging` | Pack and install Rabbithole in a clean consumer project, then verify MCP startup. |
| `npm run eval` | Run opt-in live-provider quality evaluations; credentials are required. |
| `npm run build:publish` | Assemble the ignored `publish/` directory for Cloudflare Pages. |

Individual tests are executable Node programs. During iteration, run the
narrowest relevant file directly, for example:

```bash
node test/unit/reducer.test.mjs
node test/contracts/artifact-roundtrip.test.mjs
node test/e2e/web-app.test.mjs
```

## Generated files

`dist/` is generated and committed. It is required by installs such as
`npx -y github:shlokkhemani/rabbithole`, because the package has no `prepare`
script. If a change affects `src/ui/`, shared HTML or styles, browser renderer
dependencies, or the build, run:

```bash
npm run build
npm run check:dist
```

Commit the corresponding `dist/` changes with the source. Do not hand-edit
generated bundles.

`web/dist/` and `publish/` are generated but ignored. `npm run build` recreates
`web/dist/`; `npm run build:publish` recreates both and adds deployment metadata
and public assets to `publish/`. Static deployment inputs live in
`website/public/`.

## Choosing test coverage

Add the smallest test that proves the behavior:

1. Use `test/unit/` for deterministic transformations and reducer behavior.
2. Use `test/contracts/` for persisted formats, protocol shapes, trust
   boundaries, format validation, and storage implementations.
3. Use `test/integration/` for a capability spanning core code and a host.
4. Use `test/e2e/` for browser journeys or movement between hosts.
5. Use `test/performance/` for measured regression ceilings and
   `test/packaging/` for clean-install behavior.

Every bug fix should include a regression at the lowest layer that can
reproduce it. Prefer observable behavior over private function names or
incidental DOM structure. Format changes need fixtures for accepted current
input and clearly rejected unsupported input.

Performance budgets live in `test/budgets.json`. Do not raise a ceiling merely
to make a check pass. If a reviewed product trade-off justifies a new baseline,
record the rationale and use `npm run calibrate:budgets` deliberately.

## Safe change workflow

1. Inspect the working tree and preserve unrelated changes.
2. Identify the narrowest owning layer and its public contracts before editing.
3. Add or update a focused regression test.
4. Make the smallest coherent change; avoid mixing mechanical moves with
   behavior changes.
5. Run the focused test while iterating, then the suite appropriate to the
   touched boundary.
6. Rebuild generated artifacts when browser code changes.
7. Before opening a pull request, run the complete validation set appropriate
   to the change.

For most source changes, the full local validation set is:

```bash
npm run check:types
npm run build
npm run check:dist
npm run check:purity
npm test
npm run test:packaging
```

Packaging can be run separately when iterating because it creates a clean
consumer install. Live-provider evaluations are not deterministic CI gates.

Changes to persisted holes, `.rabbithole` files, snapshot HTML, MCP tool inputs
or responses, credential storage, and asset limits are contract decisions, not
ordinary refactors. Refuse unknown formats safely and update
[Compatibility](docs/compatibility.md) alongside the relevant fixtures.

## Project invariants

- Spell the product name **Rabbithole**, as one word.
- Support Node 18 and newer and use ES modules throughout.
- Keep `src/core` independent of Node and UI code.
- Keep the MCP and web hosts separate; share only stable engine, content, UI,
  storage, and artifact contracts.
- Keep live MCP pages and frozen snapshots self-contained.
- Keep secrets out of documents, snapshots, portable files, fixtures, logs,
  and commits.
- Treat Markdown as source and rendered HTML as a derived view.
- Keep stdout reserved for the MCP protocol.

For deployment steps, see [DEPLOY.md](DEPLOY.md).
