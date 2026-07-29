# Testing Nora

Nora's tests are organized by the capability they protect. A failure should tell
the contributor whether the problem is local logic, a public contract, an
extension-host integration, a browser/webview journey, a performance budget, or
the packaged VSIX.

Deterministic source suites do not require live LLM credentials, live MCP
servers, corporate systems, or network model calls. They use fake Pi sessions,
fake providers, local fake MCP servers, temporary Git repositories, and local
fixtures.

## Install and Default Validation

```bash
npm ci --omit=optional
npm run build
npm run check
npm test
```

`npm test` runs the deterministic source suite:

1. `npm run build`
2. `npm run check`
3. `npm run test:unit`
4. `npm run test:contracts`
5. `npm run test:integration`
6. `npm run test:e2e`
7. `npm run test:performance`
8. `npm run test:packaging`

VS Code integration and installed-VSIX smoke are separate scripts because CI
wraps them in a Linux display server:

```bash
npm run test:vscode
npm run package:vsix
npm run test:vsix
```

On Linux CI these run as `xvfb-run -a npm run test:vscode` and
`xvfb-run -a npm run test:vsix`. On desktop macOS or Windows, run the scripts
directly.

## Check Scripts

- `npm run check:types` runs TypeScript over retained source, fixtures, and test
  support declarations.
- `npm run check:purity` checks webview bundle purity and self-contained UI
  boundaries.
- `npm run check:build` builds Nora twice into temporary directories and compares
  relative paths and SHA-256 hashes.
- `npm run check:native` fails if generated output, staged VSIX content, or
  production dependency inventory contains forbidden native runtime artifacts or
  excluded optional clipboard/native-canvas packages.
- `npm run check:pi-runtime` verifies copied Pi/Photon runtime assets against the
  esbuild metafile allowlist.
- `npm run check:legacy` prevents removed runtime/package/workflow surfaces from
  returning.
- `npm run check:workflows` lints GitHub Actions workflows with actionlint.

## Suite Boundaries

### Unit

`npm run test:unit`

Unit tests cover pure or narrowly scoped behavior:

- Markdown rendering, sanitization, math, code, Mermaid, and `show` blocks.
- Durable content block parsing and Check state.
- Base URL and asset URL resolution.
- Product-owned icon rendering.
- Nora document state reduction, validation, hydration projection, node/run
  states, evidence references, and immutability.
- Agent context construction.
- LLM profile validation and SecretStorage adapter behavior.
- Git remote normalization and permalink generation.
- Nora read-only code tools, skill loading, and containment.
- MCP config parsing and diagnostic redaction.
- PDF provenance and selection metadata.
- Shared lifecycle helpers.

### Contracts

`npm run test:contracts`

Contract tests protect public formats and hostile-input boundaries:

- Prompt payload fixtures.
- Webview protocol validation.
- `.nora` archive structure, canonical JSON/JSONL, size limits, hashes, path
  refusal, duplicate/case-collision refusal, deterministic output, and partial
  JSONL cutoff behavior.
- Attachment limits and deduplication boundaries.
- LLM secret exclusion from archives, exports, messages, and logs.
- Pi transcript fidelity and replayable record boundaries.
- Snapshot and Markdown export security.
- UI bundle package boundaries.

Contract changes require an explicit product, format, or security decision.
Updating the expected fixture alone is not enough.

### Integration

`npm run test:integration`

Integration tests cover complete capabilities that cross one or more runtime
boundaries:

- Nora document open/save/save-as/revert/backup, dirty tracking, undo/redo, and
  concurrent custom-editor behavior.
- Repository cache acquisition, local and remote Git behavior, worktree reuse,
  cancellation, and evidence immutability.
- Skill resource loading across workspace/global skill roots.
- Pi run control, streaming, transcript publication, cancellation, failed runs,
  save/backup races, interrupted-open recovery, and cross-document concurrency.
- MCP stdio/HTTP bridge lifecycle, variable/input resolution, tools/resources,
  timeout, reconnect, truncation, and diagnostics.
- PDF webview behavior and snapshot/image export behavior.
- LLM auth interaction with fake provider flows.
- Nora Markdown and snapshot export.
- Mermaid rendering in the retained webview/snapshot path.

### End To End

`npm run test:e2e`

E2E tests drive the webview in Chromium only:

- Initial hydration, Reader/Canvas parity, pan/zoom, node selection, search,
  keyboard navigation, checks, hostile Markdown, and reload behavior.
- Selection asks, whole-canvas asks, follow-ups, streaming, cancellation/failure
  display, and Run Details.
- Shared UI primitive focus, keyboard, dismissal, layering, combobox, dialog,
  popover, field, notice, and anchor behavior.

### VS Code

`npm run test:vscode`

VS Code tests run through `@vscode/test-electron` against the custom editor:

- Activation and opening `.nora` files.
- Dirty indicator behavior from `CustomDocumentContentChangeEvent`.
- Nora-owned undo/redo commands and keybindings.
- Save, save-as, revert, backup, hot-exit recovery, and disposal.
- Packaged research journey coverage and multi-document run behavior.

### Performance

`npm run test:performance`

`test/performance/budgets.test.mjs` enforces budgets in `test/budgets.json` for
meaningful Nora measures: activation, representative archive open/save, webview
hydration, streaming batching, snapshot size, and VSIX size.

Rebaseline only after reviewing the product trade-off. The recalibration script
is `npm run calibrate:budgets`, and it should be used only when intentionally
updating `test/budgets.json`.

Every budget records the baseline, tolerance, ceiling, rationale, and baseline
commit. Do not hide regressions by raising a ceiling without explaining the
trade-off.

### Packaging

`npm run test:packaging`

Packaging tests inspect VSIX contents and the package allowlist:

- Activation entry and generated webview assets are present.
- Source-only, secret, old-host, and forbidden native files are absent.
- The package boundary matches `.vscodeignore`.

`npm run test:vsix` installs `artifacts/nora.vsix` into a clean downloaded VS
Code test build, opens a minimal `.nora`, verifies activation without source-tree
resolution, and under `NORA_VSIX_SMOKE=1` exercises the bundled Pi SDK path with
a no-network fake provider/tool flow and Photon WebAssembly preprocessing.

## Fixtures and Support

- `test/fixtures/document-goldens/cases.json` contains reviewable Nora document
  state cases for Unicode, RTL, branches, math, code, Mermaid, checks, assets,
  evidence, and interrupted runs.
- `test/fixtures/contracts/` contains typed contract examples that must agree
  with runtime validation.
- `test/fixtures/nora/` contains minimal archive/document fixtures and run JSONL
  samples.
- `test/fixtures/pdfs/` contains small PDF fixtures for deterministic PDF
  behavior.
- `test/support/` contains fake Pi sessions, fake MCP servers, archive fixtures,
  webview harnesses, and budget measurement helpers.

Fixtures must be minimal, named for the behavior they demonstrate, and safe to
commit. Never place real credentials, private documents, corporate data, or live
provider responses in fixtures.

## Adding or Changing Tests

Choose the narrowest suite that observes the behavior:

1. Put pure transforms and single-module behavior in `unit/`.
2. Put public formats, protocol shapes, limits, persistence, and hostile-input
   boundaries in `contracts/`.
3. Put one capability spanning extension/core/webview/Git/MCP/Pi boundaries in
   `integration/`.
4. Put browser-facing journeys and reusable UI primitive behavior in `e2e/`.
5. Put VS Code custom-editor behavior in `test/vscode/`.
6. Put packaged-extension behavior in `test/packaging/`.

Prefer observable outcomes over implementation sentinels. For browser behavior,
assert accessible roles, focus, keyboard operation, persisted state, network
scope, and exported artifacts rather than incidental DOM structure. For formats,
prove both acceptance of current valid inputs and clear refusal of unsupported
or future inputs.
