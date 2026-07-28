# Build Nora as a VS Code Research Extension

## Overview

Nora will replace the fork's standalone Rabbithole delivery surfaces with one desktop VS Code extension. Opening a `.nora` file will launch a custom infinite-canvas editor for research over arbitrary Git repositories and user-configured corporate sources. An embedded Pi AgentSession will read code through Nora-owned read-only tools, use skills from `.agents/skills`, call MCP tools and resources from `.vscode/mcp.json`, and write its research back to the canvas.

The implementation is a contract-first migration in place:

1. establish the Nora document, archive, and extension-host boundaries;
2. reuse and adapt the tested renderer, reducer, canvas, Reader, PDF, snapshot, and export behavior;
3. add Pi, LLM profiles, repository acquisition, skills, and MCP behind those boundaries;
4. delete the old MCP server, browser host, BYOK web app, storage backends, website, proxy, and deployment paths only after the replacement vertical slices pass.

This approach preserves the valuable research UI while preventing the old and new host models from becoming permanent parallel products.

### Acceptance criteria

- VS Code `^1.130.0` opens and saves `.nora` files through a custom editor with Nora-owned undo/redo commands and standard desktop keybindings.
- A `.nora` file is a validated, versioned ZIP containing `manifest.json`, `document.json`, `runs/<run-id>.jsonl`, and content-addressed `assets/<sha256>` entries.
- The artifact round-trips byte-exact original attachments, complete model-facing Pi transcripts, canvas state, evidence, selected profile ID, and per-run provider/model/endpoint provenance without credentials.
- The canvas retains Reader/Canvas modes, selection branching, Markdown, origin navigation, streaming, search, keyboard navigation, PDF, lenses, `show`, checks, snapshots, synthesis, and Markdown export.
- `Ask Nora` is transient and canvas-anchored; there is no persistent standalone chat.
- Pi runs in-process through the SDK only. Nora never exposes bash, edit, or write tools to Pi.
- One Pi run may be active per document; different documents may run concurrently. Cancellation and failure preserve and label partial nodes and transcript events.
- Named global LLM profiles support Anthropic, OpenAI-compatible endpoints such as LiteLLM, OpenAI Codex subscription login, and other Pi providers that use the same credential boundary.
- Only LLM credentials are stored in VS Code SecretStorage. Nora-managed LLM credentials and MCP/Git connection credentials never enter `.nora`, logs, snapshots, or Markdown exports.
- Model-facing data returned by a user-configured MCP server is persisted losslessly as research history. Nora does not redact arbitrary tool results, so users remain responsible for what their servers return.
- Workspace `.agents/skills` and global `~/.agents/skills` are loaded; workspace names override global names with a visible diagnostic. `.pi/skills` is never read.
- `.vscode/mcp.json` supplies stdio and Streamable HTTP servers, tools, and resources. Nora does not add MCP approvals, side-effect classification, source authentication, or a read-only MCP policy.
- Arbitrary repositories are acquired into a shared bare-clone/worktree cache. Evidence records the exact commit and an immutable GitHub, GitLab, Bitbucket Cloud, or Bitbucket Data Center permalink.
- Attachments are limited to 100 MiB each and the complete archive to 1 GiB. Rejected mutations leave the last valid document unchanged.
- The shipped VSIX is universal and contains no platform-specific `.node`, `.so`, `.dylib`, or `.dll` runtime artifact. Pi's optional native clipboard packages and the existing `@napi-rs/canvas` path are absent.
- CI uses GitHub Actions, Linux, Node.js 24, and Chromium only. Generated bundles are not committed.
- A `v*` tag builds one VSIX, tests it, attaches it and a SHA-256 checksum to a GitHub Release, and publishes that exact VSIX to Visual Studio Marketplace and Open VSX.
- The old external MCP server, HTTP/SSE host, static BYOK app, IndexedDB and filesystem stores, Cloudflare worker/deployment, marketing website, `.rabbithole` compatibility code, and their obsolete tests are removed.

## Context

### Repository and guidance

- The repository is `git@github.com:r13v/Nora.git`; the planning baseline is commit `8f26071`.
- `AGENTS.md` requires explicit assumptions, minimal and surgical changes, reading callers before edits, project-convention conformance, intent-bearing tests, and completion against verification criteria.
- The codebase uses plain JavaScript ES modules with JSDoc checked by TypeScript. This plan does not introduce a TypeScript migration.
- `LICENSE` is MIT and retains the upstream Shlok Khemani copyright notice.
- `docs/SPEC.md` and `docs/adr/0001-*.md` through `docs/adr/0009-*.md` are the accepted product and architecture record.
- During migration, the existing `build.mjs`, committed `dist/`, and old host tests remain green until their bounded removal tasks. This coexistence is temporary repository scaffolding, not VSIX content or final product architecture.

### Reusable core and UI

- `src/core/reducer.js`
  - `createHoleState`
  - `holeStateToHole`
  - `holeStateToHydrationNodes`
  - `reduceHoleEvent`
- `src/core/hole-host.js`
  - `createSaveChain`
  - `applyPersistedBrowserEvent`
  - `dispatchBrowserEvent`
- `src/core/generation-run.js` exports `GenerationRun`.
- `src/core/schema.js` owns the current JSON persistence validator; it will be replaced rather than migrated because `.rabbithole` compatibility is explicitly out of scope.
- `src/core/markdown-renderer.js`, `src/core/blocks.js`, `src/core/base-url.js`, `src/core/assets.js`, `src/core/layout.js`, `src/core/pdf-shared.js`, `src/core/snapshot-html.js`, and `src/core/snapshot-projection.js` contain host-independent behavior worth retaining.
- `src/core/html/icons.js` is the canonical product-owned icon registry and remains the only location for product-owned SVG geometry.
- `src/ui/composition.js` exports `createRabbitholeUi` and already centralizes host hooks, capabilities, flush, and disposal.
- `src/ui/reader.js`, `src/ui/canvas-view.js`, `src/ui/ask-followups.js`, `src/ui/branch-surfaces.js`, `src/ui/pdf-runtime.js`, `src/ui/pdf-view.js`, `src/ui/palette.js`, and `src/ui/snapshot.js` contain the target interaction model.
- `src/web/transport/direct-host.js` demonstrates how reducer events, generation, saving, abort, and UI host hooks fit together. It is a migration reference, not a retained runtime.
- `src/web/pdf-crop.js` demonstrates browser-canvas cropping and replaces the native Node crop path.

### Code to retire after cutover

- `bin/` and `src/node/` implement the external MCP server, browser launcher, filesystem storage, local sessions, HTTP/SSE transport, and native PDF path.
- `src/web/` implements the standalone BYOK browser app, provider settings, IndexedDB store, ingestion, and direct host.
- `workers/`, `website/`, generated `web/dist/`, `scripts/build-publish.mjs`, and `.github/workflows/deploy-pages.yml` exist only for the standalone product.
- `dist/` contains committed generated browser bundles; Nora will generate ignored `out/` bundles instead.
- Host-specific tests for MCP authoring, IndexedDB, filesystem hole storage, fetch proxy, cross-host portability, web setup, and npm CLI packaging must be deleted or replaced.

### Current build and test boundaries

- `build.mjs` currently bundles the live UI and frozen client, copies PDF.js assets, builds the static app, and writes committed bundles.
- `tsconfig.json` currently checks only selected core files and contract fixtures.
- `docs/testing.md` defines unit, contract, integration, browser E2E, performance, packaging, and live-evaluation boundaries.
- Existing reducer, renderer, blocks, URL, icon, PDF UI, snapshot, sanitization, and browser-primitives tests should be adapted rather than rewritten without cause.
- Existing CI is `.github/workflows/ci.yml`; standalone deployment is `.github/workflows/deploy-pages.yml`.

### Dependencies

Pin the implementation baseline in `package-lock.json`:

- runtime:
  - `@earendil-works/pi-coding-agent@0.82.1`
  - `@modelcontextprotocol/sdk@1.30.0`
  - `jsonc-parser@3.3.1`
  - `dotenv@17.4.2`
  - `yauzl@3.4.0`
  - `yazl@3.3.1`
  - existing renderer dependencies: Mermaid Tiny, DOMPurify, Highlight.js, KaTeX, Marked, PDF.js, and Zod
- development and release:
  - `@vscode/test-electron@3.1.0`
  - `@vscode/vsce@3.9.2`
  - `ovsx@1.0.2`
  - `actionlint@2.0.6`
  - `@types/vscode@1.125.0` until a `1.130.x` declaration package is published; do not lower `engines.vscode`
  - existing `esbuild@0.28.1`, `playwright@1.62.0`, and `typescript@5.9.3`
  - `mocha@11.7.6` for the VS Code extension test runner

Do not add a ZIP framework, database, vector store, telemetry SDK, native canvas, keyring, RPC library, web framework, or separate Pi MCP package.

### Pi packaging constraint

`@earendil-works/pi-coding-agent@0.82.1` requires `@silvia-odwyer/photon-node`, whose executable payload is one architecture-neutral `.wasm` file. It also declares optional `@mariozechner/clipboard` platform packages containing `.node` binaries. Nora may ship WebAssembly but must:

- install release dependencies with `npm ci --omit=optional`;
- bundle only the Pi SDK paths Nora imports;
- never call Pi clipboard, TUI, bash, edit, or write surfaces;
- package Photon WebAssembly only for model image preprocessing used by selected PDF/image research;
- exclude optional clipboard packages from the VSIX;
- fail packaging if a `.node`, `.so`, `.dylib`, or `.dll` file is present.

### Target command surface

```bash
npm ci --omit=optional
npm run build
npm run check
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:e2e
xvfb-run -a npm run test:vscode
npm run package:vsix
xvfb-run -a npm run test:vsix
npm test
```

Task 1 establishes the script names and source suites. `test:vscode` becomes runnable in Task 4, and installed `test:vsix` becomes runnable in Task 17 after its clean-install harness exists.

## Review Handoff

- Original request: turn the Rabbithole fork into a VS Code extension that opens `.nora` research canvases, embeds Pi through its SDK, supports MCP and skills, removes unrelated product surfaces, and publishes through Linux-only GitHub Actions.
- Selected approach: contract-first migration in place, preserving core/UI behavior while replacing hosts behind explicit archive, document, webview, agent, repository, and MCP boundaries.
- Rejected approach: a clean-room rewrite would discard tested renderer/canvas behavior and create unnecessary parity work.
- Rejected approach: maintaining old and new hosts in parallel as final architecture would preserve the exact code and deployment surfaces the user asked to remove.
- Testing choice: regular implementation with tests in the same task, not strict test-first development.
- Assumption: Marketplace/Open VSX identity is `r13v.nora`, derived from the repository owner. `package.json` uses publisher `r13v` and extension name `nora`.
- Assumption: architecture-neutral WebAssembly is compatible with “universal VSIX without native runtime dependencies”; platform-specific native binaries are not.
- Accepted boundary: `capabilities.untrustedWorkspaces.supported: true` is deliberate. Nora does not add a Workspace Trust gate around user-selected skills or MCP servers; the user owns that security decision.
- Assumption: only local `file:` documents are supported in v1 because Remote SSH, Dev Containers, Codespaces, virtual workspaces, and web extensions are non-goals.
- Assumption: for a `.nora` file outside all workspace folders, one workspace folder is used automatically when exactly one exists; in a multi-root workspace Nora asks which folder supplies `.vscode/mcp.json` and `.agents/skills` for the active VS Code session. That choice is not persisted as an absolute path in `.nora`.
- MCP configuration boundary: Nora supports stdio and Streamable HTTP `servers`, `envFile`, headers, standard workspace/env/home/input substitution, and prompt/select/command inputs held only in memory. It clearly rejects legacy SSE, VS Code `sandbox`, development-server configuration, and automated OAuth flows. Authenticated HTTP remains possible through user-supplied headers, environment values, and inputs; Nora does not persist them.
- Explicit non-goals:
  - vector drawing or diagram-authoring tools;
  - persistent chat;
  - embeddings, vector database, or semantic index;
  - source-system authentication or credential storage;
  - MCP approval, read-only enforcement, or side-effect classification;
  - `.rabbithole` import or compatibility;
  - application-level `.nora` encryption;
  - telemetry and crash reporting;
  - a skill installer or marketplace;
  - Azure Pipelines;
  - dedicated Windows/macOS CI, VS Code Remote, virtual workspace, or web-extension support.
- Open questions: none.
- Hidden context: none; this plan is self-contained for a fresh executor.

## Plan Review Resolution

The isolated review on 2026-07-28 was applied before implementation:

- the provider emits only immutable `CustomDocumentContentChangeEvent` notifications, while Nora owns semantic undo/redo and treats one Agent Run as one undo unit;
- document revisions and complete JSONL byte cutoffs publish atomically, save completion has an explicit revision/finalization barrier, and exact replayable message records are separated from UI stream checkpoints;
- Pi ignores ambient `.pi` models/credentials, isolates same-provider profiles, and is exercised with Photon WASM from the installed VSIX;
- `AGENTS.md` receives transitional Nora guidance in Task 1;
- legacy deletion is split into four bounded, testable cutovers and the static build stops consuming `src/web/` before that source tree is deleted;
- `npm test`, VS Code integration, and installed-VSIX smoke have executable ordering.

The reviewer’s suggestion to disable untrusted workspaces was not applied because the accepted product decision explicitly leaves MCP/skill trust to the user and adds no Nora Workspace Trust gate.

## Development Approach

- Use regular vertical slices with tests added or updated in the same task.
- Complete every task and make its listed validation pass before starting the next task.
- Read exports, direct callers, and relevant tests before changing a reusable core or UI file.
- Keep plain JavaScript ES modules and strict JSDoc checking.
- Prefer small modules with one owner; do not add interfaces until at least two real implementations require them.
- Keep legacy code only until the corresponding Nora path passes. Do not refactor obsolete hosts.
- Keep the pre-migration build and its tests passing until the named removal task for each old host; never break an intermediate task by deleting a still-imported module.
- Every persistent or cross-process boundary must have runtime validation in addition to JSDoc types.
- Every mutation must either complete against a validated in-memory document revision or leave the previous revision unchanged.
- Update this plan immediately when implementation scope changes; prefix discovered tasks with `+`.
- Do not rely on chat history; record new decisions in this file and material architecture decisions in `docs/SPEC.md` or an ADR.

## Testing Strategy

- Unit tests cover pure document transforms, configuration parsing, path/remote normalization, skills merging, profile mapping, context construction, output bounds, and permalink formatting.
- Contract tests cover ZIP entry rules, checksums, limits, schema refusal, transcript fidelity, secret exclusion, webview message validation, and hostile content.
- Integration tests cover document save/backup/revert, Pi event-to-canvas projection, real stdio/HTTP MCP clients against local fake servers, repository cache/worktrees, PDF webview behavior, and snapshot/Markdown export.
- Chromium E2E tests cover Reader/Canvas behavior, selection asks, streamed branches, cancellation, run details, PDF selection/cropping, keyboard navigation, and export.
- VS Code integration tests cover activation, content-change dirty tracking, Nora undo/redo commands and keybindings, save/save-as/revert/backup, SecretStorage-backed profile commands, multi-document run concurrency, and extension disposal.
- VSIX smoke tests install the actual package into a clean downloaded VS Code, open a minimal `.nora`, execute a real bundled Pi SDK run against a local fake provider/tool, exercise image preprocessing, and assert the archive/package contains no forbidden native artifact or obsolete host entry.
- Tests use fake Pi sessions/models and local fake MCP servers. Deterministic suites never require live credentials, network LLMs, corporate systems, or forge accounts.
- `npm test` is the deterministic source suite and calls `build`, `check`, unit, contract, integration, and Chromium E2E tests.
- CI additionally runs `xvfb-run -a npm run test:vscode`, packages the VSIX, then runs `xvfb-run -a npm run test:vsix`. These suites remain separate because they require a Linux display wrapper and, for VSIX smoke, an already-built package.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with a `+` prefix.
- Document blockers with a `BLOCKED:` prefix.
- Keep this plan in sync with the actual repository state.
- A task is not complete while one of its listed tests or commands fails.

## What Goes Where

- Implementation Steps contain repository changes that an implementation agent can perform and verify.
- Post-Completion contains only registry accounts, federated identity, tokens, and live-system checks requiring a human or external system.

## Implementation Steps

### Task 1: Establish the Nora extension, build, and test shell

**Why:** Every later vertical slice needs a real VS Code activation point, deterministic bundles, stable commands, and package boundaries.

**Files:**

- Create: `.nvmrc`
- Create: `.vscodeignore`
- Create: `src/extension/extension.js`
- Create: `src/extension/webview-html.js`
- Create: `src/extension/protocol.js`
- Create: `src/ui/nora-entry.js`
- Create: `scripts/build-nora.mjs`
- Create: `scripts/check-build.mjs`
- Create: `scripts/check-native-artifacts.mjs`
- Create: `test/contracts/webview-protocol.test.mjs`
- Create: `test/packaging/vsix-contents.test.mjs`
- Modify: `AGENTS.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `tsconfig.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `test/packaging/install-smoke.test.mjs`

- [x] First update `AGENTS.md` with transitional guidance: all new product code and copy use Nora/`.nora`; legacy Rabbithole hosts and compatibility rules remain only until their named removal tasks and do not apply to new Nora contracts.
- [x] Change package identity to `name: "nora"`, `displayName: "Nora"`, `publisher: "r13v"`, repository `https://github.com/r13v/Nora`, and `engines.vscode: "^1.130.0"` while retaining MIT licensing and upstream attribution.
- [x] Add `main: "./out/extension.cjs"`, `extensionKind: ["ui"]`, `capabilities.virtualWorkspaces.supported: false`, `capabilities.untrustedWorkspaces.supported: true`, and no `browser` entry. The untrusted-workspace declaration is intentional because Nora adds no Workspace Trust policy around user-selected MCP servers or skills.
- [x] Contribute custom editor view type `nora.research` for `*.nora`, commands `nora.newResearch`, `nora.undo`, `nora.redo`, `nora.ask`, `nora.selectProfile`, `nora.setCredential`, `nora.signIn`, `nora.signOut`, `nora.addRepository`, `nora.addAttachment`, `nora.exportMarkdown`, and `nora.exportSnapshot`.
- [x] Add global configuration `nora.llm.profiles` and `nora.mcp.directTools`. Keep secrets out of the configuration schema.
- [x] Implement `scripts/build-nora.mjs --outdir` to bundle `src/extension/extension.js` to CommonJS with `vscode` external, bundle `src/ui/nora-entry.js` and `src/ui/frozen-entry.js` for browsers, and copy only required CSS, PDF.js, Mermaid, DOMPurify, and KaTeX assets.
- [x] Emit and package esbuild `.LEGAL.txt` files for bundled third-party license comments; retain the repository `LICENSE` and do not strip required attribution from the VSIX.
- [x] Make `out/` and `artifacts/` generated and ignored. Preserve the existing `build.mjs`, committed `dist/`, static build, and `check:dist` during the vertical-slice migration; remove the static web branch with `src/web/` in Task 14 and the remaining legacy build/dist scaffolding in Task 16. Nora bundles must not be added to Git or packaged with old hosts.
- [x] Use `npm ci --omit=optional` as the documented install and release path. Configure bundling/ignore rules so Pi clipboard packages cannot enter the VSIX.
- [x] During migration, keep `build:legacy` for the existing root build, add `build:nora`, and make `build` run both. Add `check`, `check:types`, `check:purity`, `check:build`, `check:native`, `test:unit`, `test:contracts`, `test:integration`, `test:e2e`, `test:vscode`, `package:vsix`, `test:vsix`, and `test` without dropping legacy suites that still protect reused code.
- [x] Make `package:vsix` always write `artifacts/nora.vsix`; the extension version remains inside the manifest and is checked against a release tag.
- [x] Make `scripts/check-build.mjs` run `scripts/build-nora.mjs` twice into two temporary directories and compare sorted relative paths and SHA-256 hashes.
- [x] Make `scripts/check-native-artifacts.mjs` fail on `.node`, `.so`, `.dylib`, or `.dll` files and on `@napi-rs/canvas` or `@mariozechner/clipboard` paths in `out/`, the staged VSIX contents, or production dependency inventory.
- [x] Define a discriminated, runtime-validated extension↔webview message protocol in `src/extension/protocol.js`; reject unknown message types and malformed payloads.
- [x] Generate webview HTML with a nonce CSP, `localResourceRoots`, VS Code theme variables, and `webview.asWebviewUri`; do not enable arbitrary network access or inline executable script.
- [x] Adapt the temporary npm install smoke just enough for Nora package metadata and `out/` while it still initializes the legacy MCP entry; delete that old smoke only with the external-host removal in Task 13.
- [x] Move current CI to Linux/Node.js 24 and `npm ci --omit=optional`, but retain the old-host and browser coverage needed by the still-present migration code.
- [x] Add contract tests for valid/invalid protocol messages and package-content tests for the activation entry, webview assets, absence of sources/secrets/old host files, and forbidden native artifacts.
- [x] Run `npm install --omit=optional`, the existing full deterministic tests and packaging smoke, `npm run build`, `npm run check:types`, `npm run check:build`, and `node --test test/contracts/webview-protocol.test.mjs test/packaging/vsix-contents.test.mjs`.

### Task 2: Replace Rabbithole persistence vocabulary with Nora document contracts

**Why:** The custom editor, archive, Pi, evidence, and exports need one host-independent document model without carrying `.rabbithole` compatibility.

**Files:**

- Create: `src/core/document-state.js`
- Create: `src/core/document-schema.js`
- Create: `src/core/contracts/document.d.ts`
- Create: `src/core/contracts/evidence.d.ts`
- Create: `src/core/contracts/agent-run.d.ts`
- Create: `test/unit/document-state.test.mjs`
- Create: `test/fixtures/document-goldens/cases.json`
- Create: `test/fixtures/contracts/document-fixture.js`
- Create: `test/fixtures/contracts/evidence-fixture.js`
- Create: `test/fixtures/contracts/agent-run-fixture.js`
- Modify: `src/core/assets.js`
- Modify: `src/core/base-url.js`
- Modify: `src/core/layout.js`
- Modify: `src/core/snapshot-projection.js`
- Modify: `src/ui/composition.js`
- Modify: `test/unit/pdf-provenance.test.mjs`

- [x] Define schema version `1` for `NoraDocument` with stable document/node IDs, title, canvas/view state, nodes/edges, selection/origin metadata, checks, source records, evidence records, attachment metadata, run summaries, and selected LLM profile ID.
- [x] Define `SourceRecord`, `EvidenceRecord`, and `AgentRunSummary` contracts. Evidence must include source type, stable locator, title, excerpt, revision/commit when present, immutable permalink when present, and capture time.
- [x] Implement Nora-neutral `createDocumentState`, `documentStateToPersisted`, `documentStateToHydrationNodes`, and `reduceDocumentEvent` in `src/core/document-state.js`, side by side with the old reducer until cutover.
- [x] Preserve renderer-facing Markdown, block IDs, branch ordering, streaming, canvas geometry, collapsed state, Reader state, checks, and origin navigation.
- [x] Add explicit `pending`, `running`, `complete`, `cancelled`, and `failed` run/node states; interrupted state is valid persisted data.
- [x] Validate all persisted fields and extension bags before state construction. Reject unknown future schema versions with a clear non-lossy error.
- [x] Ensure document events are immutable and failed validation does not increment the revision.
- [x] Add small Nora document-state fixtures that exercise Unicode, RTL, deep/wide branches, math, code, Mermaid, checks, assets, evidence, and interrupted runs. ZIP round trips are covered in Task 3.
- [x] Port the old reducer golden cases into `test/unit/document-state.test.mjs` so the retained behavior is explicit, but keep `src/core/reducer.js`, `src/core/generation-run.js`, `src/core/hole-host.js`, `src/core/schema.js`, `src/core/model.js`, their current callers, and legacy fixtures/tests until Task 16.
- [x] Keep shared renderer/assets/projection changes backward-compatible with the old host during migration. Update `src/ui/composition.js` only where it can accept the Nora adapter without breaking current callers; postpone visual/product copy changes until Task 5.
- [x] Run `node --test test/unit/document-state.test.mjs test/unit/reducer.test.mjs test/unit/content-blocks.test.mjs test/unit/markdown-renderer.test.mjs`, `npm run check:types`, the existing contract suite, and `npm run check:dist`.

### Task 3: Implement the streaming `.nora` ZIP format

**Why:** The binary custom document and every later integration depend on safe, lossless, bounded archive persistence.

**Files:**

- Create: `src/extension/archive/constants.js`
- Create: `src/extension/archive/manifest.js`
- Create: `src/extension/archive/reader.js`
- Create: `src/extension/archive/writer.js`
- Create: `src/extension/archive/workspace.js`
- Create: `src/extension/archive/hash.js`
- Create: `src/core/contracts/archive.d.ts`
- Create: `test/contracts/nora-archive.test.mjs`
- Create: `test/contracts/nora-archive-security.test.mjs`
- Create: `test/support/nora-archive-fixture.mjs`
- Create: `test/fixtures/nora/minimal-document.json`
- Create: `test/fixtures/nora/interrupted-run.jsonl`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] Use `yauzl` in lazy-entry mode and `yazl` in streaming mode; do not buffer a whole archive or 100 MiB attachment in memory.
- [x] Define `manifest.json` as `{format:"nora", formatVersion:1, documentId, createdAt, updatedAt, entries:[{path, mediaType, bytes, sha256}]}`. The entry list covers every entry except the manifest itself and is sorted by path.
- [x] Store canonical UTF-8/LF `document.json`, one JSON object per LF-terminated line in `runs/<run-id>.jsonl`, and raw bytes in `assets/<lowercase-sha256>`.
- [x] Validate entry paths, duplicate names, case collisions, unsupported encryption, CRC errors, declared and streamed sizes, manifest coverage, hashes, asset-name hashes, JSON/JSONL shapes, and aggregate size before exposing a document.
- [x] Enforce `100 * 1024 * 1024` raw bytes per asset, at most `1024 * 1024 * 1024` total uncompressed entry bytes, and at most `1024 * 1024 * 1024` bytes for the final ZIP file. Include ZIP metadata overhead conservatively in the preflight estimate.
- [x] Stage changed structured entries and newly added assets in a per-open-document temporary directory. Clean normal and stale Nora temp directories without deleting unrelated paths.
- [x] Write saves to an explicit sibling temporary file, fsync the file, rename atomically over the target, and fsync the parent directory on local filesystems. A failure must retain the previous target and in-memory revision.
- [x] In the Windows `EPERM`/`EEXIST` replacement path, rename the old target to a sibling backup, move the fsynced temporary file into place, restore the backup if the second rename fails, and delete the backup only after success. Cover this branch with injected filesystem-operation tests even though CI remains Linux-only.
- [x] Preserve unchanged asset bytes exactly. Content-address identical additions to the existing entry without duplication.
- [x] Let the archive writer accept an immutable per-run byte cutoff, read only complete JSONL records at or before that cutoff, and ignore later staged bytes that belong to a newer document revision.
- [x] Write entries in sorted path order with ZIP timestamp `1980-01-01T00:00:00Z` and regular-file mode `0o100600`; deflate JSON/JSONL at level 9 and store content-addressed assets without recompression so identical logical inputs build byte-identical archives.
- [x] Change `updatedAt` only when the logical document revision changes, not on a no-op save, so repeated saves of the same revision are deterministic.
- [x] Accept only format version 1. Report newer versions without attempting partial reconstruction. Do not add `.rabbithole` import.
- [x] Test empty/minimal documents, multiple runs, immutable byte cutoffs, trailing partial/unpublished JSONL bytes, binary byte equality, duplicate assets, exact size boundaries, oversize preflight, traversal, duplicate/case-colliding names, corrupt CRC/hash, undeclared entries, truncated JSONL, future format/schema, interrupted write, and deterministic output.
- [x] Run `node --test test/contracts/nora-archive.test.mjs test/contracts/nora-archive-security.test.mjs` and `npm run check:types`.

### Task 4: Implement the VS Code custom document lifecycle

**Why:** `.nora` must behave like a real editable VS Code resource, including dirty state, undoable canvas edits, save, save-as, revert, backup, and clean disposal.

**Files:**

- Create: `src/extension/nora-document.js`
- Create: `src/extension/nora-editor-provider.js`
- Create: `src/extension/document-registry.js`
- Create: `src/extension/document-mutation-queue.js`
- Create: `src/extension/workspace-scope.js`
- Create: `src/extension/commands/document-commands.js`
- Create: `test/integration/nora-document-lifecycle.test.mjs`
- Create: `test/vscode/run.mjs`
- Create: `test/vscode/suite/index.cjs`
- Create: `test/vscode/suite/custom-editor.test.cjs`
- Modify: `src/extension/extension.js`
- Modify: `src/extension/protocol.js`
- Modify: `src/extension/webview-html.js`
- Modify: `src/ui/nora-entry.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Implement `NoraDocument` with validated state, monotonic revision, saved revision, one serialized mutation queue, Nora-owned semantic undo/redo stacks, archive workspace, active-run handle, and webview subscriptions. A published snapshot contains `{revision, documentState, runByteCutoffs}` captured under that queue.
- [ ] Implement `NoraEditorProvider` methods `openCustomDocument`, `resolveCustomEditor`, `saveCustomDocument`, `saveCustomDocumentAs`, `revertCustomDocument`, and `backupCustomDocument`.
- [ ] Register `nora.research` with `supportsMultipleEditorsPerDocument: false` and `retainContextWhenHidden: true`.
- [ ] Use exactly one VS Code change model: fire a fresh immutable `CustomDocumentContentChangeEvent` from `onDidChangeCustomDocument` after every committed mutation; never emit `CustomDocumentEditEvent`.
- [ ] Keep undo/redo inside `NoraDocument` as semantic before/after snapshots with run cutoffs. Normal entries are immutable once pushed; an active run keeps a fixed before snapshot and updates its private after snapshot until terminal, then freezes it. Coalesce pointer-drag geometry into one stack entry at pointer release, clear redo on a new user edit, and apply undo/redo without recursively pushing history while still incrementing revision and firing a content-change event.
- [ ] Contribute `nora.undo`/`nora.redo` keybindings with `key: "ctrl+z"` / `mac: "cmd+z"` and `key: "ctrl+shift+z"` / `mac: "cmd+shift+z"`, scoped by `activeCustomEditorId == nora.research`. Webview toolbar/menu actions invoke the same commands; do not depend on VS Code's provider-managed edit stack.
- [ ] Track a deterministic fingerprint of the last saved `{documentState, runByteCutoffs}`. If Nora undo returns exactly to it, invoke the scoped VS Code save command after the content-change event so VS Code clears its dirty indicator through the normal provider save path; a save failure leaves the document dirty. Revert clears Nora undo/redo history.
- [ ] Treat an entire Agent Run as one Nora undo entry. Its immutable before snapshot is fixed at run start; its current after snapshot is replaced internally as complete transcript/message/tool events and bounded assistant checkpoints commit, while every commit independently notifies VS Code with a content-change event.
- [ ] Undoing an active run aborts and drains its event pump, completes its `cancelled` terminal record/status in the run entry, captures that cancelled partial after snapshot for redo, then restores the exact pre-run state/cutoffs and fires one content-change event. Redo restores the captured cancelled partial run; completed-run undo/redo restores exact pre-run/final snapshots.
- [ ] Enqueue snapshot capture after all earlier mutations, capture immutable `{revision, documentState, runByteCutoffs}`, then release the queue while streaming the ZIP. After the write, reacquire an exclusive save-finalization barrier: if the current revision differs, reject with a retryable save-conflict error so VS Code stays dirty even though the target safely contains the older snapshot.
- [ ] When the revision still matches, update the saved fingerprint and resolve the `saveCustomDocument` promise while the finalization barrier remains held; release queued mutations with `setImmediate` on the next extension-host turn. This guarantees their fresh content-change events occur after VS Code processes save completion and marks the saved revision clean.
- [ ] `backupCustomDocument` uses the same snapshot path and may capture an active run. On recovery, the existing interrupted-run rule terminalizes a persisted `running` run.
- [ ] Implement backup to the exact VS Code-provided destination and delete it through the returned `CustomDocumentBackup`. Reopen `openContext.backupId` rather than the original URI, validate it as a normal archive, and consume `openContext.untitledDocumentData` for new untitled documents.
- [ ] Restrict v1 document URIs and Save As targets to `file:` and show a clear error for unsupported schemes.
- [ ] Implement `Nora: New Research` by writing a valid minimal ZIP before calling `vscode.openWith`.
- [ ] Resolve the active workspace folder from the document URI; when the document is outside a multi-root workspace, prompt for the session scope.
- [ ] Dispose webview listeners, abort the document's active run, release MCP references, close ZIP handles, and remove staging files when the document closes.
- [ ] Test content-change events only, one fresh notification per committed revision, scoped keybinding routing to Nora undo/redo, undo-to-saved clean-state resynchronization and save-failure behavior, drag coalescing, one Nora undo entry for a complete/failed/cancelled run, exact active-run undo and cancelled-partial redo, completed-run undo/redo, save-conflict rejection during active streaming, post-resolution event ordering, save-as/revert, repeated active-run backup/hot-exit recovery, invalid archive refusal, unsupported URI schemes, and two concurrently open documents. Assert the real VS Code tab dirty indicator, not only Nora's internal saved revision.
- [ ] Run `node --test test/integration/nora-document-lifecycle.test.mjs`, `npm run build`, and `xvfb-run -a npm run test:vscode`.

### Task 5: Port and brand the research canvas inside the webview

**Why:** The extension must preserve the existing research experience without carrying standalone-browser settings, routing, persistence, or chat.

**Files:**

- Modify: `src/ui/composition.js`
- Modify: `src/ui/nora-entry.js`
- Modify: `src/ui/reader.js`
- Modify: `src/ui/canvas-view.js`
- Modify: `src/ui/ask-followups.js`
- Modify: `src/ui/branch-surfaces.js`
- Modify: `src/ui/palette.js`
- Create: `src/ui/run-status.js`
- Delete after port: `src/ui/transport-status.js`
- Modify: `src/ui/chrome-init.js`
- Modify: `src/ui/snapshot.js`
- Modify: `src/core/html/shell.js`
- Modify: `src/core/html/styles.js`
- Modify: `src/core/html/icons.js`
- Create: `test/e2e/webview-research.test.mjs`
- Create: `test/support/webview-harness.mjs`
- Modify: `test/e2e/ui-primitives-browsers.test.mjs`
- Modify: `test/e2e/reducer-browser-parity.test.mjs`

- [ ] Rename user-facing product copy and UI globals from Rabbithole to Nora while keeping `src/core/html/icons.js` as the only product icon source.
- [ ] Replace SSE/HTTP/direct-host assumptions with the validated `acquireVsCodeApi().postMessage` protocol and initial-state hydration from `NoraDocument`.
- [ ] Preserve Reader and Canvas switching, pan/zoom, drag/resize/collapse/layout, edges anchored to selected text, branch sidebar, breadcrumbs/origin navigation, Markdown/math/code/Mermaid/`show`, checks, selection marks, search, and keyboard navigation.
- [ ] Make `Ask Nora` a transient popup. Selected-node asks carry that node ID; no selection carries an explicit whole-canvas scope.
- [ ] Keep follow-up composers on result nodes and remove any UI that presents a separate persistent conversation list.
- [ ] Add a Run Details view reached from a result node. It renders persisted messages/tool activity as technical trace but does not become a second chat composer.
- [ ] Render `running`, `cancelled`, and `failed` state accessibly and keep partial content selectable and exportable.
- [ ] Use VS Code theme variables while retaining the product layout and ensure all dialogs/popovers restore focus and support keyboard-only use.
- [ ] Change the UI primitives E2E matrix to Chromium only.
- [ ] Test initial hydration, selection ask, whole-canvas ask, follow-up, streaming, cancellation/failure display, run details, Reader/Canvas parity, keyboard search/navigation, checks, hostile Markdown, and webview reload.
- [ ] Run `npm run build`, `node --test test/e2e/webview-research.test.mjs test/e2e/ui-primitives-browsers.test.mjs`, and `npm run check:purity`.

### Task 6: Implement global LLM profiles and SecretStorage credentials

**Why:** Pi needs a provider/model runtime that supports Anthropic, corporate LiteLLM, Codex subscription, and Pi-compatible providers without leaking credentials into documents.

**Files:**

- Create: `src/extension/llm/profile-store.js`
- Create: `src/extension/llm/secret-credential-store.js`
- Create: `src/extension/llm/model-runtime.js`
- Create: `src/extension/llm/auth-interaction.js`
- Create: `src/extension/commands/llm-commands.js`
- Create: `test/unit/llm-profiles.test.mjs`
- Create: `test/contracts/llm-secret-boundary.test.mjs`
- Create: `test/integration/llm-auth.test.mjs`
- Modify: `src/extension/extension.js`
- Modify: `src/extension/nora-document.js`
- Modify: `src/extension/protocol.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Validate global `nora.llm.profiles` entries with stable `id`, `label`, `provider`, `model`, optional `baseUrl`, optional Pi API type, and optional custom-model metadata. Reject duplicate IDs and secret-looking fields.
- [ ] Reject profile `baseUrl` values containing URL userinfo or credential-bearing query parameters; the corporate endpoint is non-secret configuration and its token belongs only in SecretStorage.
- [ ] Use SecretStorage keys `nora.llm.credential.<profile-id>` and store the Pi `Credential` JSON required for API-key or OAuth refresh. Never copy credentials into VS Code settings or `.nora`.
- [ ] Implement a `ProfileCredentialStore(profileId, runtimeProviderId)` adapter for Pi's provider-keyed `CredentialStore` interface. Map `read`, `list`, serialized `modify`, and `delete` only for that runtime provider to `nora.llm.credential.<profile-id>` and reject other provider IDs; this keeps two profiles for the same provider isolated.
- [ ] Build one `ModelRuntime` per active profile with `modelsPath: null`, `modelsStore: new InMemoryModelsStore()`, and model-catalog network refresh disabled. Register custom OpenAI-compatible profiles against the configured `baseUrl`, model, and selected `openai-completions` or `openai-responses` API; use `openai-completions` as the LiteLLM default.
- [ ] Resolve built-in Anthropic and other Pi provider profiles from the Pi model catalog. Resolve `openai-codex` through Pi's provider-owned OAuth login and refresh.
- [ ] Adapt Pi `AuthInteraction` to VS Code input boxes, quick picks, progress notifications, external authorization URLs, device codes, and cancellation.
- [ ] Implement set credential, sign in, sign out, and select profile commands. Store only the selected profile ID in the document.
- [ ] Refuse a run before constructing the runtime when the selected profile is missing, invalid, has no SecretStorage credential, or cannot resolve its exact model. Prompt for an explicit replacement; never silently fall back to `~/.pi/agent/models.json`, Pi credential files, or ambient provider environment variables.
- [ ] At run start, copy non-secret provider, model, endpoint, and profile ID into immutable run provenance.
- [ ] Ensure OutputChannel messages, thrown errors, snapshots, Markdown export, webview messages, and archive fixtures never contain Nora-managed API keys, access tokens, refresh tokens, or authorization headers.
- [ ] Test profile validation, LiteLLM mapping, credential serialization, concurrent OAuth refresh mutation, Codex login interaction with fake provider flow, concurrent same-provider profile isolation, missing-profile refusal, and secret scans over exported artifacts/log messages. In a temporary home, create `.pi/agent/models.json` and Pi credential files and set provider API-key environment variables; prove all are ignored.
- [ ] Run `node --test test/unit/llm-profiles.test.mjs test/contracts/llm-secret-boundary.test.mjs test/integration/llm-auth.test.mjs` and `npm run check:types`.

### Task 7: Acquire immutable Git worktrees and generate forge permalinks

**Why:** Nora must research arbitrary repositories and turn every code citation into durable evidence pinned to an exact commit.

**Files:**

- Create: `src/extension/git/process.js`
- Create: `src/extension/git/remote.js`
- Create: `src/extension/git/cache.js`
- Create: `src/extension/git/repository.js`
- Create: `src/extension/git/evidence.js`
- Create: `src/extension/git/forge/github.js`
- Create: `src/extension/git/forge/gitlab.js`
- Create: `src/extension/git/forge/bitbucket-cloud.js`
- Create: `src/extension/git/forge/bitbucket-data-center.js`
- Create: `src/extension/commands/repository-commands.js`
- Create: `test/unit/git-remote.test.mjs`
- Create: `test/unit/git-permalink.test.mjs`
- Create: `test/integration/repository-cache.test.mjs`
- Modify: `src/extension/extension.js`
- Modify: `src/extension/nora-document.js`

- [ ] Wrap system Git with `spawn("git", args, {shell:false})`, cancellation, bounded stdout/stderr, and diagnostics that omit credential-bearing URLs.
- [ ] Place shared cache data under `<ExtensionContext.globalStorageUri>/git`: bare clones under `bare/<sha256-acquisition-url>` and detached worktrees under `worktrees/<repository-id>/<commit-sha>`.
- [ ] For a remote acquisition URL, clone/fetch the bare repository and create a detached worktree for the requested revision or fetched default branch.
- [ ] Reject HTTP(S) acquisition URLs containing passwords/tokens in URL userinfo or credential query parameters. Store and hash only the sanitized acquisition URL; Git authentication must come from the system credential helper, SSH agent, or environment.
- [ ] For a local repository, mirror/fetch it into the same cache so research sees committed bytes at exact HEAD rather than mutable/uncommitted working-tree content.
- [ ] Resolve local-repository remote by current branch upstream, then `origin`, then an explicit user choice. Remember the acquisition URL separately from the permalink remote.
- [ ] Before minting a forge permalink for a local repository, fetch the selected remote and prove the selected commit is reachable from one of its remote-tracking refs with `git for-each-ref --contains <sha> refs/remotes`. If it is not published, ask the user to select a fetched upstream revision or push it; never emit a broken permalink for an unpushed commit.
- [ ] Normalize HTTPS, SSH URL, and SCP-style remotes without embedding user info, tokens, or query credentials.
- [ ] Detect github.com, gitlab.com, and bitbucket.org automatically. For unknown hosts, ask the user to choose GitHub Enterprise, GitLab self-managed, or Bitbucket Data Center and store that forge type with the source.
- [ ] Implement immutable URL adapters:
  - GitHub: `/<owner>/<repo>/blob/<sha>/<path>#L<start>-L<end>`
  - GitLab: `/<namespace>/<repo>/-/blob/<sha>/<path>#L<start>-<end>`
  - Bitbucket Cloud: `/<workspace>/<repo>/src/<sha>/<path>#<filename>-<start>`; retain the end line in the evidence record because the verified Cloud permalink shape guarantees the start anchor
  - Bitbucket Data Center: `/projects/<project>/repos/<repo>/browse/<path>?at=<sha>`; retain start/end lines and excerpt in evidence because Data Center anchor syntax varies by supported server release
- [ ] Percent-encode path/query components without encoding `/` path separators; validate line ranges and repository containment.
- [ ] Store repository ID, sanitized remote, acquisition URL, forge type/base URL, exact SHA, relative path, lines, excerpt, and permalink in evidence.
- [ ] Make refresh fetch/create a new revision record and worktree. Never rewrite evidence already pinned to an older SHA.
- [ ] Reference-count open-document worktrees and prune only unreferenced worktrees; never delete bare caches during normal document disposal.
- [ ] Test remote precedence, URL normalization, self-hosted classification, path encoding, line anchors, SHA pinning, refusal of unpushed local HEAD, selection of a reachable remote revision, local dirty-tree exclusion, cache reuse, concurrent acquisition, cancellation, missing Git/credentials, and refresh immutability using temporary local repositories.
- [ ] Run `node --test test/unit/git-remote.test.mjs test/unit/git-permalink.test.mjs test/integration/repository-cache.test.mjs` and `npm run check:types`.

### Task 8: Add Nora-owned read-only code tools and skills

**Why:** Pi must research multiple acquired repositories and use the selected skills without receiving source mutation or unrestricted command capabilities.

**Files:**

- Create: `src/extension/agent/code-tools.js`
- Create: `src/extension/agent/skill-tools.js`
- Create: `src/extension/agent/canvas-tools.js`
- Create: `src/extension/agent/resource-loader.js`
- Create: `src/extension/skills/loader.js`
- Create: `test/unit/code-tools.test.mjs`
- Create: `test/unit/skills-loader.test.mjs`
- Create: `test/integration/skills-resource-loader.test.mjs`
- Modify: `src/extension/workspace-scope.js`
- Modify: `src/extension/nora-document.js`

- [ ] Expose custom Pi tools for repository listing, directory listing, file finding, text search, bounded file reads, and evidence capture. Every request carries a repository ID and a relative path.
- [ ] Resolve paths with realpath containment under the acquired immutable worktree; reject absolute paths, traversal, symlink escapes, device files, and oversized reads.
- [ ] Register a standard-name `read` tool for skill resources that accepts only absolute realpaths inside the merged workspace/global skill base directories. This lets Pi load `SKILL.md` references while refusing arbitrary filesystem reads.
- [ ] Implement search through fixed `git grep` argument construction, not a shell string. Cap results and return an explicit truncation marker.
- [ ] Expose only minimal canvas tools to create a node, update an agent-created node, and attach evidence. Validate ownership and document revision before mutation.
- [ ] Do not register Pi's bash, edit, write, unrestricted filesystem, package-manager, clipboard, or image-conversion tools.
- [ ] Load exactly `<workspace>/.agents/skills` and `~/.agents/skills` with Pi's skill parser. Do not call default discovery that reads `.pi`, ancestor repositories, extensions, prompts, themes, or unrelated agent config.
- [ ] Merge skills by name with workspace precedence. Keep shadow/malformed-skill diagnostics in the loader and emit a visible diagnostic naming both paths when a workspace skill shadows a global skill.
- [ ] Implement Pi's `ResourceLoader` interface with the merged skill list, Nora's system prompt, and empty extensions/prompts/themes/agent-files. Skill content remains at its source path and is read on invocation.
- [ ] Watch both skill directories and rebuild the resource loader for the next run after changes; do not mutate a running AgentSession's resources.
- [ ] In the system prompt, state that code is immutable, repository IDs are required, evidence must be captured for code claims, MCP may have side effects, and canvas mutations must use Nora tools.
- [ ] Test repository containment, skill-resource containment, relative skill references, symlink escape, binary/large file handling, bounded search, evidence construction, exact discovery paths, shadow warnings, malformed skill diagnostics, `.pi/skills` exclusion, and no mutation tool registration.
- [ ] Run `node --test test/unit/code-tools.test.mjs test/unit/skills-loader.test.mjs test/integration/skills-resource-loader.test.mjs` and `npm run check:types`.

### Task 9: Embed Pi AgentSession and persist canvas-anchored runs

**Why:** The core product flow is an in-process Pi run whose exact model-facing history and partial results remain portable in the `.nora` document.

**Files:**

- Create: `src/extension/agent/context-builder.js`
- Create: `src/extension/agent/transcript.js`
- Create: `src/extension/agent/pi-session.js`
- Create: `src/extension/agent/run-controller.js`
- Create: `scripts/check-pi-runtime-assets.mjs`
- Create: `test/support/fake-pi-session.mjs`
- Create: `test/unit/agent-context.test.mjs`
- Create: `test/contracts/agent-transcript.test.mjs`
- Create: `test/integration/pi-run.test.mjs`
- Modify: `src/extension/nora-document.js`
- Modify: `src/extension/nora-editor-provider.js`
- Modify: `src/extension/protocol.js`
- Modify: `src/ui/nora-entry.js`
- Modify: `scripts/build-nora.mjs`
- Modify: `scripts/check-native-artifacts.mjs`

- [ ] Create Pi sessions only with `createAgentSession`, `ModelRuntime`, the Nora `ResourceLoader`, `SessionManager.inMemory()`, and Nora custom tools. Add no RPC executable, subprocess, fallback, or protocol.
- [ ] Do not initialize Pi telemetry, update checks, package downloads, crash reporting, or default model-catalog network refresh. The only allowed runtime network traffic is the selected LLM provider, user-configured MCP HTTP servers, Git, and explicit OAuth login.
- [ ] Use a new AgentSession for each run. Rebuild the ancestor context by calling `SessionManager.inMemory()` and replaying the persisted model-facing user, assistant, tool-call, and tool-result messages through `SessionManager.appendMessage()` before passing it to `createAgentSession`.
- [ ] Give every logical Pi message a stable message ID and define distinct JSONL record kinds: replayable committed user/assistant/tool-call/tool-result messages, non-replayable assistant stream checkpoints for partial UI/crash recovery, and terminal run records. Replay folds checkpoints into at most one cancelled/interrupted partial assistant message only when no committed version exists; it never appends each delta/checkpoint as a separate Pi message.
- [ ] For a selected node, build context from that node, its origin/evidence, and its ancestor result-run chain. With no selection, build a deterministic whole-canvas projection ordered by graph/root order and omit technical UI state.
- [ ] Preflight the selected/whole-canvas projection against the exact model context window with room for the prompt and response. Do not silently drop nodes or evidence; reject an oversized initial context before creating the run and tell the user to select a narrower node.
- [ ] Start a run with UUID, parent run ID when applicable, target node ID, prompt, context-scope metadata, immutable LLM provenance, start time, and `running` status.
- [ ] Keep the active run on `NoraDocument` and use the existing document registry for document lookup; do not add a second run registry.
- [ ] Subscribe to Pi events before `session.prompt()`. For each model-facing user/assistant/tool-call/tool-result event: compute and validate the next document state and one complete LF-terminated JSON record, append all record bytes to the staged run file, then publish the new run byte cutoff, document state, revision, and the Nora run undo entry's current after snapshot together through the document mutation queue. Fire a fresh content-change event and notify webviews after publication.
- [ ] At each bounded assistant UI batch, append one non-replayable checkpoint record with the stable message ID and current partial content, then publish its cutoff/state through the same mutation path. The later committed assistant-message record supersedes those checkpoints for replay.
- [ ] Never expose or persist bytes beyond the last published complete-record cutoff. On reopen, ignore or truncate unpublished trailing bytes. A save or backup captures document state and every run cutoff in the same queued snapshot, releases the queue, then lets the archive writer stream only those immutable prefixes while later events continue.
- [ ] Undo removes the run reference/cutoff but leaves its staged bytes available for redo. If a new edit invalidates redo, treat that run file as unreferenced staging and exclude it from every save; garbage-collect it on document disposal or the next safe staging cleanup.
- [ ] Persist the complete arguments and the complete bounded result actually shown to Pi, including MCP results. Exclude retries, reconnect chatter, raw transport diagnostics, and internal stack traces.
- [ ] Stream assistant deltas through one reducer-backed result node, batching webview and Nora run-entry after-snapshot updates at complete message/tool boundaries and at most every 100 ms or 4 KiB. A tool-created node is validated through the same document event path.
- [ ] Enforce one active run per `NoraDocument`; keep run controllers independent across documents.
- [ ] Wire cancellation to `AbortController` and Pi session abort. On cancel or failure, flush transcript/state, label the run and partial result node, and perform no rollback.
- [ ] On completion, flush final assistant content and transcript before marking the run complete. A save cannot publish `complete` without its terminal transcript event.
- [ ] Publish the terminal transcript record and terminal run/node summary as one atomic document mutation so persisted transcript status cannot disagree with `document.json`.
- [ ] On open, treat persisted `running` runs as `failed` with an `interrupted` reason because no in-process session survived; retain all prior material.
- [ ] Make Run Details read from transcript projections without exposing credential values or adapter diagnostics.
- [ ] Emit an esbuild metafile from `scripts/build-nora.mjs`; derive and verify an explicit runtime-asset allowlist, copy Photon’s architecture-neutral `photon_rs_bg.wasm` and required third-party licenses to stable `out/` paths, and fail when a package-relative Pi/Photon runtime asset is referenced but absent. Keep platform-native optional packages excluded.
- [ ] Test selected/whole-canvas context, deterministic ordering, oversized-context refusal without mutation, follow-up ancestry, event ordering, tool arguments/results, streaming, one-run lock, cross-document concurrency, cancel, provider error, extension shutdown, and interrupted-open recovery. Assert message-for-message replay equivalence with the original Pi `SessionManager`, including streamed, tool, cancelled, and interrupted cases. Add forced save/backup races at user-message, assistant-checkpoint, message-commit, tool-call, tool-result, cancel, and completion boundaries and prove every archive contains a mutually consistent document revision and complete JSONL prefixes.
- [ ] Run `node --test test/unit/agent-context.test.mjs test/contracts/agent-transcript.test.mjs test/integration/pi-run.test.mjs`, `npm run build`, `node scripts/check-pi-runtime-assets.mjs`, and `npm run check:native`.

### Task 10: Implement the shared MCP supervisor and Pi bridge

**Why:** Corporate research depends on user-configured MCP tools and resources, while Nora must avoid duplicate server processes and unnecessary auth/policy surfaces.

**Files:**

- Create: `src/extension/mcp/config.js`
- Create: `src/extension/mcp/variables.js`
- Create: `src/extension/mcp/supervisor.js`
- Create: `src/extension/mcp/connection.js`
- Create: `src/extension/mcp/pi-tool.js`
- Create: `src/extension/mcp/output.js`
- Create: `test/support/fake-mcp-stdio-server.mjs`
- Create: `test/support/fake-mcp-http-server.mjs`
- Create: `test/unit/mcp-config.test.mjs`
- Create: `test/unit/mcp-output.test.mjs`
- Create: `test/integration/mcp-bridge.test.mjs`
- Modify: `src/extension/agent/pi-session.js`
- Modify: `src/extension/extension.js`
- Modify: `src/extension/workspace-scope.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Parse `<workspace>/.vscode/mcp.json` as JSONC with `jsonc-parser` and validate top-level `servers` plus optional `inputs`.
- [ ] Support stdio `{type:"stdio", command, args, cwd, env, envFile}` and Streamable HTTP `{type:"http", url, headers}` using official `StdioClientTransport` and `StreamableHTTPClientTransport`.
- [ ] Resolve `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}`, and `${input:id}`. Use `dotenv` for `envFile`.
- [ ] Resolve `promptString` and `pickString` inputs with VS Code UI and `command` inputs through `vscode.commands.executeCommand`. Keep resolved input values only in the connection's memory and discard them on disconnect.
- [ ] Reject legacy SSE, OAuth automation, sandbox, development-server fields, unresolved variables, invalid headers/env, and unsupported transport fields with server-specific diagnostics.
- [ ] Key shared connections by workspace folder, server name, and normalized non-secret configuration hash. Reference-count them across documents and start a server only on the first actual tool/resource request.
- [ ] Refresh tool/resource lists when MCP list-change notifications arrive. On config change, let in-flight calls finish, then recreate the connection on the next call.
- [ ] Apply a two-minute call timeout, cancellation propagation, at most two reconnect attempts, and clean stdio child shutdown when the last reference releases.
- [ ] Bound each model-facing MCP result to 256 KiB UTF-8 and 2,000 text lines with an explicit truncation record. The transcript stores exactly that bounded result.
- [ ] Expose one `mcp` Pi tool with `search`, `describe`, `call`, `list_resources`, and `read_resource` operations. Register direct tools only for exact `server/tool` names in global `nora.mcp.directTools`.
- [ ] Use stable direct tool names `mcp__<sanitized-server>__<sanitized-tool>` and preserve original server/tool names in arguments and transcript metadata.
- [ ] Do not implement approval prompts, side-effect filtering, `readOnlyHint` enforcement, MCP OAuth, MCP credential storage, sampling, elicitation, prompts, or imports from Pi/Codex/Claude configs.
- [ ] Log only server ID, operation, status, duration, and bounded error class in the Nora OutputChannel. Never log URLs, env/header values, tool arguments, tool results, or resolved inputs.
- [ ] Test JSONC, variables, envFile, each input type, unsupported fields, lazy shared stdio lifecycle, Streamable HTTP, tools/resources, direct allowlist, list changes, timeout, cancellation, reconnect limit, config rotation, output truncation, and diagnostic redaction.
- [ ] Run `node --test test/unit/mcp-config.test.mjs test/unit/mcp-output.test.mjs test/integration/mcp-bridge.test.mjs` and `npm run check:types`.

### Task 11: Port attachment and PDF workflows into the webview

**Why:** Original corporate/research source files must live in `.nora`, while PDF rendering and cropping must not introduce a native extension-host dependency.

**Files:**

- Create: `src/extension/attachments.js`
- Create: `src/extension/commands/attachment-commands.js`
- Create: `src/ui/pdf-crop.js`
- Create: `test/contracts/attachment-boundaries.test.mjs`
- Create: `test/integration/pdf-webview.test.mjs`
- Modify: `src/core/pdf-shared.js`
- Modify: `src/ui/pdf-runtime.js`
- Modify: `src/ui/pdf-view.js`
- Modify: `src/ui/nora-entry.js`
- Modify: `src/extension/nora-document.js`
- Modify: `src/extension/nora-editor-provider.js`
- Modify: `src/extension/webview-html.js`
- Modify: `src/extension/protocol.js`
- Delete after port: `src/node/pdf-ingest.js`
- Delete after port: `src/node/pdf-crop.js`
- Delete after port: `src/web/pdf-crop.js`

- [ ] Add attachments through a VS Code file picker and through validated MCP resource results. Preflight exact per-asset and aggregate archive limits before document mutation.
- [ ] When an MCP resource contains a binary blob, stream and hash the raw blob into the archive before producing the bounded model-facing resource result; return its attachment/evidence reference to Pi and persist that same bounded reference in the transcript.
- [ ] Compute SHA-256 while streaming bytes into the archive staging area; deduplicate by hash and store title, media type, original filename, bytes, and source/evidence linkage in `document.json`.
- [ ] Lazily materialize a verified archive asset into the document temp directory and expose only that directory through the webview's `localResourceRoots`.
- [ ] Load and render PDFs with bundled PDF.js in the webview. Move browser-canvas crop behavior from `src/web/pdf-crop.js` to `src/ui/pdf-crop.js`.
- [ ] Extract selectable page text in the webview and persist a conversion node only when the user chooses the existing convert-to-document action.
- [ ] Return crop PNG bytes to the extension through the validated protocol, pass the normal attachment preflight, and link the new asset to its PDF page/region provenance.
- [ ] Put user-selected PDF text or region metadata into the next `Ask Nora` prompt context. Pass a selected crop to Pi as image content through the SDK image-preprocessing path while preserving the original PDF and crop assets plus their provenance in `.nora`.
- [ ] Keep original PDFs byte-exact in `assets/<sha256>`; rendered pages/crops never replace originals.
- [ ] Keep Markdown/image URLs within VS Code webview/resource CSP and preserve lightbox/selection behavior.
- [ ] Test exact 100 MiB acceptance and one-byte oversize rejection without allocating giant fixture buffers, total-limit preflight, hash dedupe, MIME/name handling, lazy materialization, PDF text/image context, crop provenance, Photon WASM loading, malformed PDF, webview reload, and no native canvas dependency.
- [ ] Run `node --test test/contracts/attachment-boundaries.test.mjs test/integration/pdf-webview.test.mjs test/unit/pdf-selection.test.mjs test/unit/pdf-provenance.test.mjs`, `npm run build`, `node scripts/check-pi-runtime-assets.mjs`, and `npm run check:native`.

### Task 12: Adapt snapshots, synthesis, and Markdown export

**Why:** The retained sharing and research-output features must project the Nora document deliberately and must not leak credentials or internal run transport data.

**Files:**

- Modify: `src/core/snapshot-html.js`
- Modify: `src/core/snapshot-projection.js`
- Modify: `src/ui/frozen-entry.js`
- Modify: `src/ui/snapshot.js`
- Create: `src/core/markdown-export.js`
- Create: `src/extension/commands/export-commands.js`
- Create: `test/contracts/export-security.test.mjs`
- Create: `test/integration/nora-export.test.mjs`
- Modify: `test/integration/pdf-snapshot.test.mjs`
- Modify: `test/integration/image-experience.test.mjs`

- [ ] Keep snapshots self-contained, inert, read-only HTML with the frozen client, visible canvas/Reader state, cited evidence, and only referenced asset bytes.
- [ ] Exclude selected profile IDs, run transcripts, tool arguments/results, MCP configuration, local cache/worktree paths, and all Nora-managed connection credentials from snapshots and Markdown. Visible research nodes remain user-authored/source data and are exported verbatim after normal content sanitization.
- [ ] Add evidence footnotes to Markdown export and stable source links to snapshots.
- [ ] Preserve math, code highlighting, Mermaid, `show`, checks in clean initial state, PDF/image presentation, origin navigation, and hostile-content sanitization.
- [ ] Implement synthesis as a normal whole-canvas `Ask Nora` run whose result is a canvas node, not a separate export-time model path.
- [ ] Use VS Code save dialogs for `.md` and `.html` targets and report write failures without mutating the `.nora` document.
- [ ] Test offline snapshot loading, referenced-only assets, script-breakout resistance, evidence links, Markdown ordering, interrupted nodes, exclusion of known credential sentinels from non-visible run/config fields, preservation of visible research text, and failed destination writes.
- [ ] Run `node --test test/contracts/export-security.test.mjs test/integration/nora-export.test.mjs test/integration/pdf-snapshot.test.mjs test/integration/image-experience.test.mjs` and `npm run build`.

### Task 13: Remove the external Node/MCP host and filesystem product

**Why:** The Nora extension now owns persistence, Pi, PDF, and MCP; the external authoring server can be removed without coupling that deletion to other products.

**Files:**

- Delete: `bin/`
- Delete: `src/node/`
- Delete: `test/contracts/filesystem-store.test.mjs`
- Delete: `test/contracts/mcp-markdown-wire.test.mjs`
- Delete: `test/contracts/artifact-roundtrip.test.mjs`
- Delete: `test/contracts/assets.test.mjs`
- Delete: `test/contracts/data-boundaries.test.mjs`
- Delete: `test/e2e/cross-host-journey.test.mjs`
- Delete: `test/integration/generation-lifecycle.test.mjs`
- Delete: `test/integration/mcp-rearm.test.mjs`
- Delete: `test/integration/pdf-conversion.test.mjs`
- Delete: `test/integration/pdf-ingestion.test.mjs`
- Delete: `test/integration/pdf-node-conversion.test.mjs`
- Delete: `test/packaging/install-smoke.test.mjs`
- Delete: `test/fixtures/contracts/artifact-fixture.js`
- Delete: `test/fixtures/contracts/generation-fixture.js`
- Delete: `test/fixtures/contracts/store-fixture.js`
- Delete: `test/support/store-contract.mjs`
- Modify: `test/integration/mermaid-rendering.test.mjs`
- Modify: `test/unit/base-url.test.mjs`
- Modify: `test/unit/content-blocks.test.mjs`
- Modify: `test/unit/markdown-renderer.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

- [ ] Before deletion, use import search and the replacement matrix to confirm each old test is obsolete or covered by the named Nora archive, document, Pi, MCP, or PDF test. Port retained renderer, Mermaid, base-URL, and content tests from Node-host HTML/session helpers to the Nora build and webview/archive fixtures; confirm Task 12 already removed Node-host imports from retained snapshot/image tests.
- [ ] Remove the package `bin`/CLI metadata, browser launching, local HTTP/SSE transport, filesystem `.rabbithole` sessions, native PDF ingestion/crop path, and the npm MCP install smoke.
- [ ] Remove deleted legacy fixtures/tests from `tsconfig.json` and package scripts in the same change so `npm run check:types` and each retained suite remain runnable.
- [ ] Remove `@napi-rs/canvas` and Node-host-only dependencies after `npm ls` and import review.
- [ ] Run the Nora archive/custom-editor/Pi/MCP/PDF suites plus retained reducer, renderer, snapshot, and Chromium tests; run `npm ls --all` and resolve invalid production dependencies before proceeding.

### Task 14: Remove the standalone web/IndexedDB/provider product

**Why:** Once the webview vertical slice passes, the BYOK browser application and its independent persistence/provider stack have no retained consumer.

**Files:**

- Delete: `src/web/`
- Delete: `test/contracts/indexeddb-store.test.mjs`
- Delete: `test/contracts/compatibility-security.test.mjs`
- Delete: `test/integration/custom-endpoint.test.mjs`
- Delete: `test/integration/pdf-gc.test.mjs`
- Delete: `test/integration/pdf-precision.test.mjs`
- Delete: `test/integration/web-ingestion.test.mjs`
- Delete: `test/e2e/enter-composition.test.mjs`
- Delete: `test/e2e/web-app-canvas-sharing.test.mjs`
- Delete: `test/e2e/web-app-learning.test.mjs`
- Delete: `test/e2e/web-app-setup.test.mjs`
- Delete: `test/unit/model-endpoint.test.mjs`
- Delete: `test/unit/ollama-diagnostics.test.mjs`
- Delete: `test/unit/hole-id.test.mjs`
- Delete: `test/unit/pdf-import-error.test.mjs`
- Delete: `test/unit/pdf-ingest-staging.test.mjs`
- Delete: `test/unit/pdf-transcription-capability.test.mjs`
- Delete: `test/unit/preferences-store.test.mjs`
- Delete: `test/unit/provider-registry.test.mjs`
- Delete: `test/support/provider-mock.mjs`
- Delete: `test/support/web-app-harness.mjs`
- Delete: `test/evals/`
- Modify: `build.mjs`
- Modify: `test/contracts/ui-bundle-boundaries.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/check-ui-purity.mjs`

- [ ] First remove the static web-app branch from `build.mjs` and prove the temporary legacy build still produces the committed `dist/` bundles. Then remove IndexedDB persistence, standalone routing/ingestion, browser provider settings, OpenRouter/Ollama setup, and direct-host transport after their Nora replacements pass.
- [ ] Remove `fake-indexeddb` and provider-only packages after import review; keep shared UI, renderer, PDF.js, snapshot, sanitization, and Chromium primitive coverage.
- [ ] Run `npm run build`, `npm run check:purity`, all retained unit/contract/integration tests, and the webview Chromium E2E suite.

### Task 15: Remove the website, fetch proxy, and Cloudflare deployment

**Why:** Marketing/static hosting is independent of the extension runtime and can be deleted as one bounded deployment change.

**Files:**

- Delete: `workers/`
- Delete: `website/`
- Delete: `scripts/build-publish.mjs`
- Delete: `.github/workflows/deploy-pages.yml`
- Delete: `test/contracts/fetch-proxy-worker.test.mjs`
- Delete: `test/support/static-server.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

- [ ] Remove the fetch proxy, static-site build scripts, Pages/Cloudflare deployment, and their package scripts/dependencies.
- [ ] Confirm CI no longer expects website artifacts, then run `npm run build`, `npm run check`, `npm test`, and `git diff --check`.

### Task 16: Remove final legacy contracts/build scaffolding and enforce the Nora boundary

**Why:** After all old hosts are gone, the temporary dual build and `.rabbithole` contracts can be removed without breaking intermediate tasks.

**Files:**

- Delete: `dist/`
- Delete: `build.mjs`
- Delete: `scripts/check-dist.mjs`
- Delete: `docs/compatibility.md`
- Delete: `src/core/portable-import.js`
- Delete: `src/core/portable-projection.js`
- Delete: `src/core/store.js`
- Delete: `src/core/reducer.js`
- Delete: `src/core/hole-host.js`
- Delete: `src/core/schema.js`
- Delete: `src/core/generation-run.js`
- Delete: `src/core/contracts/artifact.d.ts`
- Delete: `src/core/contracts/store.d.ts`
- Delete: `src/core/contracts/engine.d.ts`
- Delete: `src/core/contracts/generation.d.ts`
- Delete: `src/ui/entry.js`
- Delete: `test/integration/artifact-portability.test.mjs`
- Delete: `test/integration/pdf-portability-caps.test.mjs`
- Delete: `test/unit/reducer.test.mjs`
- Delete: `test/fixtures/corpus/`
- Create: `scripts/check-legacy-surfaces.mjs`
- Modify: `src/core/model.js`
- Modify: `src/core/html/README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `scripts/check-ui-purity.mjs`
- Modify: `test/support/budget-measurements.mjs`
- Modify: `.gitignore`

- [ ] Read all remaining imports before deletion. Port only still-used generic helpers from the old reducer/contracts into the Nora document or focused shared modules; retain `src/core/model.js` only for genuinely host-independent helpers and remove its old contract imports.
- [ ] Delete tests only when the capability is obsolete or covered by a named Nora replacement. Retain renderer, document reducer, blocks, base URL, icons, PDF UI, snapshots, sanitization, performance, and Chromium primitive coverage.
- [ ] Make `build` invoke only `scripts/build-nora.mjs`, remove `build:legacy`/`check:dist`, and keep `out/` and `artifacts/` ignored.
- [ ] Delete old `.rabbithole` fixtures and compatibility assertions; retain no importer or hidden fallback.
- [ ] Make `scripts/check-legacy-surfaces.mjs` fail when runtime/package/workflow code contains `.rabbithole`, `rabbithole`, old MCP tool names, `IndexedDB`, the fetch proxy, `RABBITHOLE_*`, `@napi-rs/canvas`, or website/deploy entries. Allow historical mentions only in `LICENSE`, `docs/SPEC.md`, ADRs, and this plan.
- [ ] Update `tsconfig.json` to check all retained `src/**/*.js`, contract fixtures, and test support types without pointing at deleted paths.
- [ ] Run `npm prune --omit=optional`, `npm run build`, `npm run check`, `npm test`, and `npm ls --all`; resolve missing, extraneous, or invalid production dependencies.

### Task 17: Replace CI and add single-artifact release publishing

**Why:** The extension needs reproducible Linux validation and identical Marketplace/Open VSX provenance without Azure Pipelines or a Marketplace PAT.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-release-version.mjs`
- Create: `scripts/check-workflows.mjs`
- Create: `src/extension/testing/pi-smoke.js`
- Create: `test/packaging/vsix-install-smoke.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Make CI run only on `ubuntu-latest` with Node.js 24 and `npm ci --omit=optional`.
- [ ] Install only Playwright Chromium and Linux browser dependencies.
- [ ] Run `npm test`, `xvfb-run -a npm run test:vscode`, deterministic build and Pi-runtime-asset verification, VSIX packaging, then `xvfb-run -a npm run test:vsix`.
- [ ] Upload the tested VSIX as the CI artifact. Do not run a Windows/macOS matrix.
- [ ] Make `test/packaging/vsix-install-smoke.test.mjs` download the VS Code test build, install the built VSIX into clean extensions/user-data directories, list `r13v.nora`, open a minimal `.nora`, and verify activation without source-tree or development `node_modules` resolution.
- [ ] Under `NORA_VSIX_SMOKE=1` only, expose a private activation API from `src/extension/testing/pi-smoke.js`. It must construct the real bundled `ModelRuntime` and `AgentSession`, run a no-network fake provider through one tool call/result, preprocess a tiny image through Photon WASM, and return an assertion-friendly result. The API is absent in normal activation.
- [ ] Trigger release only for `v*` tags. Verify the tag without `v` exactly equals `package.json` version.
- [ ] Grant release workflow permissions `contents: write` and `id-token: write`.
- [ ] Build and test once, package `artifacts/nora.vsix`, generate `artifacts/nora.vsix.sha256`, and transfer both between jobs through GitHub Actions artifacts.
- [ ] Create/update the GitHub Release and upload that exact VSIX/checksum.
- [ ] Authenticate with `azure/login` through OIDC using repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` plus `allow-no-subscriptions: true`.
- [ ] Publish the downloaded `artifacts/nora.vsix` to Visual Studio Marketplace with `vsce publish --packagePath artifacts/nora.vsix --azure-credential`.
- [ ] Publish the same downloaded file to Open VSX with `ovsx publish artifacts/nora.vsix -p "${{ secrets.OVSX_PAT }}"`.
- [ ] Compare the SHA-256 before each publish and fail if either job rebuilt or changed the artifact.
- [ ] Pin third-party actions to immutable commit SHAs and annotate the corresponding release tag in comments. Resolve current official SHAs when implementing the workflow because action revisions are security-sensitive and time-dependent.
- [ ] Implement `scripts/check-workflows.mjs` with `actionlint.createLinter()`, lint both workflow files, and make any diagnostic fail `npm run check:workflows`.
- [ ] Run `npm run package:vsix`, `node scripts/check-pi-runtime-assets.mjs`, `npm run check:native`, `xvfb-run -a npm run test:vsix`, and `npm run check:workflows`.

### Task 18: Verify acceptance criteria and runtime boundaries

**Why:** This is a cross-cutting migration; passing narrow tests is insufficient without proving the packaged user journeys and absence of removed surfaces.

**Files:**

- Create: `test/vscode/suite/research-journey.test.cjs`
- Create: `test/vscode/suite/multi-document-runs.test.cjs`
- Create: `test/packaging/package-boundaries.test.mjs`
- Modify: `test/performance/budgets.test.mjs`
- Modify: `test/budgets.json`

- [ ] Run the packaged journey: create `.nora`, select an LLM profile, attach a PDF, add two local Git repositories, ask from a selected node through a fake Pi model, invoke a fake MCP resource/tool, capture code evidence, follow up, cancel a second run, save, close, reopen, export Markdown/snapshot, and verify all retained state.
- [ ] Prove two documents can run concurrently while one document rejects a second simultaneous run.
- [ ] Prove a malicious/corrupt archive, webview message, Markdown payload, repo path, and MCP result cannot escape its validation/sanitization boundary.
- [ ] With fake providers/MCP/Git and network interception enabled, prove Nora makes no telemetry, crash-report, update-check, or unrelated catalog request.
- [ ] Scan unpacked VSIX contents for secrets, old hosts, native binaries, source maps with local paths, uncommitted generated files, and files outside the package allowlist.
- [ ] Rebaseline performance budgets only for meaningful Nora measures: extension activation, minimal/representative archive open/save, webview hydration, streaming batching, snapshot size, and VSIX size. Record rationale and baseline commit.
- [ ] Run `npm ci --omit=optional`.
- [ ] Run `npm run build`.
- [ ] Run `npm run check`.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:contracts`.
- [ ] Run `npm run test:integration`.
- [ ] Run `npm run test:e2e`.
- [ ] Run `xvfb-run -a npm run test:vscode`.
- [ ] Run `npm run package:vsix`.
- [ ] Run `xvfb-run -a npm run test:vsix`.
- [ ] Run `node scripts/check-pi-runtime-assets.mjs` and `npm run check:native`.
- [ ] Run `git diff --check` and confirm `git status --short` contains no generated `out/`, `artifacts/`, `dist/`, or `web/dist` file.

### Task 19: Finalize product and contributor documentation

**Why:** The current README and agent guidance describe a different product and would cause users and future implementers to take the wrong path.

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/testing.md`
- Modify: `docs/design-system.md`
- Create: `docs/nora-format.md`
- Create: `docs/llm-profiles.md`
- Create: `docs/mcp.md`
- Create: `docs/repositories-and-evidence.md`
- Move on completion: `docs/plans/20260728-nora-vscode-research-extension.md` to `docs/plans/completed/20260728-nora-vscode-research-extension.md`

- [ ] Rewrite README installation and quick start for VSIX/Marketplace/Open VSX, `.nora` custom editor, LLM profile setup, Codex sign-in, LiteLLM URL/token, repository acquisition, `.vscode/mcp.json`, and `.agents/skills`.
- [ ] State clearly that Nora does not authenticate corporate sources, restrict MCP side effects, encrypt artifacts, collect telemetry, or support Remote/web extension hosts.
- [ ] Replace Task 1's transitional `AGENTS.md` guidance with the final extension/core/UI/archive/agent/MCP/git structure, Node 24, generated `out/`, extension-host logging, no native binaries, and the new validation commands.
- [ ] Document the exact archive schema, checksums, limits, transcript contract, v1 compatibility boundary, and safe failure behavior in `docs/nora-format.md`.
- [ ] Document non-secret profile settings and SecretStorage lifecycle without showing real tokens in `docs/llm-profiles.md`.
- [ ] Document supported/rejected `.vscode/mcp.json` fields, variable/input lifetime, shared server lifecycle, output bounds, and the user's responsibility for MCP security in `docs/mcp.md`.
- [ ] Document repository cache layout, Git credential delegation, remote precedence, self-hosted forge selection, immutable revisions, and permalink/evidence shapes in `docs/repositories-and-evidence.md`.
- [ ] Update `docs/testing.md` to match the exact scripts and suite ownership; remove web/MCP-server/IndexedDB/npm-tarball instructions.
- [ ] Confirm `docs/SPEC.md` remains accepted, has no unresolved decision introduced by implementation, and update its plan link to `docs/plans/completed/20260728-nora-vscode-research-extension.md`.
- [ ] Run all documentation examples that are executable, `npm run check`, `npm test`, and `git diff --check`.
- [ ] Move this plan to `docs/plans/completed/` only after every prior checkbox and acceptance criterion is complete.

## Technical Details

### Runtime ownership

```text
VS Code extension host
├── NoraEditorProvider / NoraDocument
├── archive reader/writer + per-document staging
├── global LLM profile/SecretStorage adapter
├── per-document Pi RunController
├── shared MCP Supervisor
├── shared Git bare-clone/worktree cache
└── validated webview message bridge
    └── Nora UI: Reader + Canvas + PDF + transient Ask Nora
```

- Core state and projections stay host-independent.
- The extension host owns filesystem, ZIP, Git, credentials, Pi, MCP, and VS Code APIs.
- The webview owns visual interaction, Markdown rendering, PDF rendering/cropping, and sends only validated document intents.
- The webview never receives LLM/MCP credentials, raw repository filesystem roots unless required for a display label, or direct arbitrary filesystem/network capability.

### `.nora` invariants

- `manifest.json` is the only root of trust for contained entries after ZIP structural validation.
- `document.json` references assets and runs by hash/ID; every reference must resolve and every stored entry must be declared.
- Asset names equal the SHA-256 of raw bytes.
- Run files are append-ordered JSONL. A mutation appends one complete LF record before atomically publishing its byte cutoff with the matching document revision; bytes beyond the published cutoff are never exposed or saved.
- Terminal summary status and terminal transcript event are published in the same mutation and must agree.
- No Nora-managed profile credential, MCP input/header/env value, Git credential, absolute worktree path, or temp path may enter portable state.
- A bounded MCP tool/resource result shown to Pi is research history and is persisted exactly; Nora does not inspect or redact arbitrary returned data.
- Save captures immutable document state and per-run byte cutoffs under the document mutation queue, then writes that snapshot atomically. Oversize or invalid mutation is rejected before the in-memory revision changes.
- Same logical state produces deterministic ZIP bytes.

### Agent run flow

```text
Ask intent
→ resolve document/workspace/profile
→ build selected-node or whole-canvas context
→ create running run + placeholder result node
→ create in-process Pi AgentSession with Nora tools/resources
→ append each complete Pi event/batch record
→ publish transcript cutoff + reducer revision together
→ complete | cancel | fail
→ publish terminal transcript + run/node status together
→ mark custom document dirty
```

- Run context never comes from a separate chat database.
- Follow-up context is reconstructed from the selected result node and its ancestor run chain.
- MCP result limits are applied before the value reaches Pi and before it is appended to the transcript.
- The custom editor fires only fresh immutable `CustomDocumentContentChangeEvent` values. Nora owns semantic undo/redo; one Agent Run is one Nora undo entry even though streamed checkpoints independently notify VS Code for dirty tracking and hot-exit backup.
- Save and backup may capture a consistent active-run prefix. Normal save rejects if the revision advanced during its write; otherwise its short finalization barrier delays newer content-change events until after VS Code processes save completion. Recovery marks a persisted running prefix interrupted.
- The custom editor remains responsive while extension-host work runs and all long operations accept cancellation.

### MCP security boundary

- Nora faithfully connects to user-selected servers; it does not claim their tools are safe or read-only.
- Stdio processes run with the configured command/environment and inherited OS identity.
- HTTP requests use configured URLs/headers after variable resolution.
- Nora stores no MCP secret in SecretStorage or `.nora`; resolved inputs live only for the connection lifetime.
- Diagnostics exclude URLs, headers/env, inputs, arguments, results, and credentials.

### Git/evidence boundary

- Research tools operate only on immutable cached worktrees at exact SHAs.
- System Git owns network protocols, SSH agent, credential helper, proxy, and certificate behavior.
- `.nora` stores enough sanitized remote/forge/SHA/path/line/excerpt data to understand and revisit evidence without embedding clones.
- Refresh creates a new repository revision and new evidence; it never changes old permalinks.

### Distribution invariants

- `out/` is always generated from source.
- `vsce package --no-dependencies` packages the already-bundled extension and webview assets.
- Release installs with `--omit=optional`; optional platform clipboard packages are absent, while allowlisted Photon WebAssembly is copied to a stable runtime path.
- The VSIX must be identical across GitHub Release, Marketplace, and Open VSX.
- Linux-only CI is an explicit scope choice, not a claim that Windows/macOS behavior was tested.

## Post-Completion

### Marketplace and identity setup

- Reserve publisher/namespace `r13v` in Visual Studio Marketplace and Open VSX so the package ID is `r13v.nora`.
- Create or select a Microsoft Entra tenant and application for Marketplace publishing. A paid Azure subscription and Azure Pipelines are not required for the selected subscriptionless `azure/login` flow.
- Associate the Entra application/service principal with the Visual Studio Marketplace publisher and grant extension publishing permission.
- Add a GitHub federated identity credential restricted to this repository and the protected release environment/tag workflow.
- Add GitHub repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
- Create an Eclipse Foundation account, sign the Open VSX Publisher Agreement, reserve namespace `r13v`, create an Open VSX access token, and add it as GitHub secret `OVSX_PAT`.
- Protect the GitHub release environment and require human approval before registry publishing.

### Manual release verification

- Install the release VSIX from GitHub Releases into clean stable VS Code `1.130.x` on one desktop.
- Confirm Codex subscription login and one real prompt through Pi.
- Confirm one real corporate LiteLLM profile with its URL/token.
- Confirm one user-owned stdio MCP server and one Streamable HTTP MCP server.
- Confirm one corporate-source skill/MCP workflow against non-production test data.
- Confirm GitHub, GitLab/self-managed, Bitbucket Cloud, and Bitbucket Data Center permalinks against repositories the user is authorized to access.
- Download the Marketplace and Open VSX packages and compare their SHA-256 hashes with the GitHub Release VSIX.
