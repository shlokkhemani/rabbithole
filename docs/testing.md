# Testing Rabbithole

Rabbithole's tests are organized by the capability they protect. A failure should
tell a contributor whether the problem is local logic, a public contract, a host
integration, a user journey, a performance budget, or the published package.

The default suite runs deterministic checks that do not require live provider
credentials. Packaging smoke tests and live-provider evaluations are separate
because they are slower or environment-dependent.

## Running tests

```bash
npm test
npm run test:packaging
npm run eval
```

Individual files are ordinary Node programs and can be run directly while
iterating:

```bash
node test/unit/reducer.test.mjs
node test/contracts/artifact-roundtrip.test.mjs
node test/e2e/web-app.test.mjs
```

Browser suites use Playwright. The UI primitives matrix exercises Chromium,
Firefox, and WebKit; the product journeys use the browser selected by their test
harness.

## Suite boundaries

### Unit tests

`test/unit/` contains deterministic, DOM-free or narrowly DOM-scoped behavior.
These tests should be fast and should avoid host orchestration.

- `markdown-renderer.test.mjs` protects math delimiters, code highlighting,
  Markdown composition, safe fallback for malformed or incomplete input, raw HTML
  escaping, and the live/export page assembly needed for offline rendering.
- `content-blocks.test.mjs` protects durable visual-block identity, registered
  block normalization, descriptor and mount registration, pending placeholders,
  framework-owned sanitization, and the Check block's parse, prose, and mount
  contracts.
- `base-url.test.mjs` protects link and image URL resolution, unsafe URL rejection,
  GitHub image rewriting, frontmatter inference and precedence, child inheritance,
  and MCP `base_url` validation.
- `icons.test.mjs` protects the canonical icon renderer, accessibility defaults,
  size overrides, favicon generation, and the repository boundary that forbids
  product-owned inline SVG geometry outside `src/core/html/icons.js`.
- `reducer.test.mjs` is the shared document-engine conformance suite. Its reviewable
  cases live in `test/fixtures/reducer-goldens/cases.json` and run in Node and a
  browser. They cover branch creation, streaming ordering and retries, completion,
  deletion, updates, view state, extension state, immutability, unknown events,
  and host-specific hydration projections.

### Contract tests

`test/contracts/` protects formats and boundaries that other runtimes or
untrusted input can reach. Changes here require an explicit contract or
security decision; updating an assertion is not by itself sufficient.

- `assets.test.mjs` covers asset persistence, name and size validation, Markdown
  references, MCP manifest and string limits, safe serving, referenced-only
  export, and progress events.
- `filesystem-store.test.mjs` and `indexeddb-store.test.mjs` instantiate the shared
  store contract in `test/support/store-contract.mjs`. Both backends must support
  hole and asset CRUD, schema stamping, future-schema refusal,
  staging and adoption, traversal rejection, and reference-aware asset cleanup.
- `mcp-markdown-wire.test.mjs` protects renderer fixtures, Markdown-only hydration
  and progress events, MCP tool response shapes, streaming accumulation, canonical
  export, web import, future-schema refusal,
  and the isolation of learner block state from agent context and snapshots.
- `fetch-proxy-worker.test.mjs` protects the relay boundary: GET-only access,
  hostname allowlisting, credential stripping, CORS/content preservation, and the
  streaming response-size cap.
- `data-boundaries.test.mjs` couples the typed store, artifact, generation, and
  content vocabularies to runtime validators. It covers canonical normalization,
  extension bags, unknown format/schema refusal, malformed JSON and
  base64, wrong field types, Unicode and RTL text, durable block IDs, import caps,
  secret exclusion, failure cleanup, and the exact per-asset byte boundary.
- `artifact-roundtrip.test.mjs` runs every corpus fixture through portable import,
  the filesystem store, canonical snapshot HTML, web snapshot import, and portable
  export. The projections must be normalized fixed points; referenced assets stay
  byte-exact, extension state follows projection policy, and identity collisions
  mint fresh hole IDs without changing content.
- `compatibility-security.test.mjs` exercises hostile imported Markdown and visual
  blocks on live and frozen paths, safe KaTeX degradation and trusted structure,
  fully offline asset-bearing snapshots, frozen control policy, secret exclusion
  from every artifact, and portable asset MIME derivation.

### Integration tests

`test/integration/` checks a complete capability across core code and one or more
host adapters without owning the broad product journey.

- `pdf-ingestion.test.mjs` covers page rendering, text extraction, ranges,
  text-free ingestion, staged adoption, direct hole ingestion, and malformed or
  missing inputs. A real-paper quality probe is optional when its local fixture is
  available.
- `image-experience.test.mjs` covers Markdown image behavior, shared image controls
  and styles, and the real MCP Share action producing a canonical, portable,
  referenced-assets-only snapshot.
- `mermaid-rendering.test.mjs` covers lazy hosted-app loading, self-contained MCP
  rendering, strict sanitization, invalid-source fallback, theme-aware rerendering,
  conditional runtime embedding, and zero-network offline snapshots.
- `mcp-rearm.test.mjs` protects the keep-listening response, grace period, live
  reattachment, waiter cleanup, and exactly-once requeue of a saved pending ask.
- `web-ingestion.test.mjs` protects local browser PDF ingestion, arXiv proxy
  fallback and recovery messages, future-schema import refusal, MIME-independent
  file classification, and the Markdown pre-read size limit.
- `artifact-portability.test.mjs` covers provider selection in the portable shell,
  author-stream invocation, credential-free `.rabbithole` export, download naming,
  binary asset import, and the public deployment artifact.
- `generation-lifecycle.test.mjs` protects OpenAI-compatible SSE
  framing under arbitrary fragmentation, title extraction, normalized errors,
  byte-preserving adapters, `GenerationRun` ordering and accumulation, browser and
  MCP wiring, retry guards, empty-stream policy, authoring persistence, and browser
  lifecycle flushes.

### End-to-end tests

`test/e2e/` drives shipped user surfaces in a real browser.

- `web-app.test.mjs` covers the landing and composer, setup readiness, saved-hole
  in-document hole switching, deletion and undo, streaming and reload recovery, reader/canvas navigation,
  selection and whole-document branching, settings and provider controls,
  accessible dialogs and popovers, keyboard operation, focus restoration,
  Check-state persistence, image preview, canonical snapshot export, and frozen
  behavior.
- `ui-primitives-browsers.test.mjs` runs the shared Button, Field, Layer, Anchor,
  Popover, Dialog, Notice, Select, and Combobox contracts in Chromium, Firefox,
  and WebKit. It concentrates cross-engine keyboard, focus, dismissal, labeling,
  timing, and placement behavior in one matrix.
- `cross-host-journey.test.mjs` proves a current hole can travel through MCP
  authoring, browser interaction, snapshot
  download, fresh-profile web import, portable export, filesystem import, and MCP
  resume without content, asset, identity, or credential regressions.

### Performance tests

`test/performance/budgets.test.mjs` enforces machine-relative ceilings recorded in
`test/budgets.json`. The gauges cover live and frozen client bytes, representative
snapshot bytes and build time, cold open, streaming DOM batching and duration,
and the final-update-to-save window.

Re-baseline only after reviewing the product trade-off:

```bash
npm run calibrate:budgets
```

Each budget records its baseline, tolerance, ceiling, rationale, and measurement
commit. A faster or smaller result does not require recalibration; a regression
must not be hidden by raising a ceiling without explanation.

### Packaging tests

`test/packaging/install-smoke.test.mjs` packs the repository, installs the tarball
into a clean consumer project, verifies the executable, metadata, runtime source,
and committed browser bundles, then completes an MCP initialize handshake. It is
kept outside the default suite and should run against every supported Node release
in CI.

### Live-provider evaluations

`test/evals/run-eval.mjs` is an opt-in quality probe, not a deterministic contract
suite. It uses live providers and heuristic scoring for math, diagrams, explanation
lenses, code-aware answers, follow-ups, synthesis, long documents, title handling,
hostile selected text, and baseline factual responses. See
`test/evals/README.md` for credentials and invocation details.

## Data and protocol contracts

The following surfaces are deliberately tested across versions and hosts:

| Surface | Required behavior | Primary coverage |
|---|---|---|
| Persisted holes | Current records round-trip canonically; other schema versions are refused before lossy reconstruction. | Store contracts, data boundaries, cross-host journey |
| Portable `.rabbithole` files | Valid files round-trip canonically; malformed, oversized, or newer formats fail clearly; import collisions receive fresh identity. | Data boundaries, artifact round-trip, artifact portability |
| Snapshot HTML | Exports are inert, self-contained, escaped against script breakout, offline-capable, and include only referenced assets and shareable state. | MCP wire, compatibility/security, web app, artifact round-trip |
| MCP tools and events | Tool inputs, responses, progress events, reattachment, and hydration remain compatible with supported clients. | Assets, MCP wire, MCP rearm, reducer |
| Browser storage | IndexedDB data round-trips without drift; credentials remain device-local and never enter holes or exports. | IndexedDB contract, compatibility/security, web app |
| Renderer and blocks | Markdown source remains authoritative; unsafe markup and URLs are rejected consistently on live and frozen paths; durable block IDs survive import and edits. | Renderer, content blocks, MCP wire, compatibility/security |
| Cross-host documents | Content, referenced asset bytes, durable asks, and supported metadata survive movement between MCP, web, snapshots, and portable files. | Artifact round-trip, cross-host journey |

Keep the unsupported-input failure mode as carefully tested as the happy path.

## Fixtures and test support

- `test/fixtures/corpus/` contains curated portable files for empty, math-heavy,
  visual-block, Mermaid, asset-bearing, deep and wide, pending, Unicode, RTL,
  code-fence, base-URL, view-state, origin, and mixed-status documents. Its README
  records the purpose of each fixture.
- `test/fixtures/reducer-goldens/cases.json` is the reviewable state/effect corpus
  for the shared reducer.
- `test/fixtures/contracts/` provides typed examples that must agree with runtime
  validation.
- `test/support/store-contract.mjs` is instantiated by both storage backends and is
  not an independently executed suite.
- `test/support/budget-measurements.mjs` and
  `test/support/calibrate-budgets.mjs` own performance measurement and deliberate
  re-baselining.

Fixtures should be minimal, named for the behavior they demonstrate, and safe to
commit. Never place real credentials or private documents in the corpus.

## Adding or changing tests

Choose the narrowest suite that observes the contract:

1. Put pure transformations and reducer behavior in `unit/`.
2. Put public formats, persistence, protocol shapes, limits, and
   trust boundaries in `contracts/`.
3. Put one capability spanning a host boundary in `integration/`.
4. Put browser journeys and cross-host workflows in `e2e/`.
5. Put measured regression ceilings in `performance/` and clean-install behavior
   in `packaging/`.

Prefer observable outcomes over implementation sentinels. For browser behavior,
assert accessible roles, focus, keyboard operation, persisted state, network
scope, and exported artifacts rather than private function names or incidental DOM
nesting. For format behavior, prove both acceptance of current inputs and clear
refusal of unsupported inputs.

Every bug fix should add a regression at the lowest layer that can reproduce it.
If the defect crossed a public boundary or a real user journey, add that coverage
too. Keep test output capability-named so CI failures remain understandable on
their own.
