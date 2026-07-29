# Notes for agents working in this repo

This repository develops Nora, a desktop VS Code extension that opens `.nora`
research archives in a custom infinite-canvas editor.

## What This Is

- `src/extension/` owns the VS Code extension host, custom editor lifecycle,
  archive IO, Pi runs, LLM profiles, SecretStorage, MCP supervision, Git
  acquisition, commands, and packaging-only test hooks.
- `src/extension/archive/` owns the `.nora` ZIP reader, writer, manifest
  validation, staging workspace, and content hashes.
- `src/extension/agent/` owns Pi context construction, transcript projection,
  Nora read-only tools, canvas tools, and run control.
- `src/extension/mcp/` owns `.vscode/mcp.json` parsing, variable/input
  resolution, shared stdio/HTTP connections, output bounding, and Pi tool
  bridging.
- `src/extension/git/` owns system-Git execution, shared bare-clone/worktree
  cache, remote normalization, forge permalink adapters, and evidence records.
- `src/core/` owns host-independent document state, runtime schemas, renderer,
  Markdown export, snapshot projection, PDF shared data, HTML shell assets, and
  product-owned icons.
- `src/ui/` owns the VS Code webview runtime: Reader, Canvas, PDF rendering and
  cropping, transient Ask Nora, run details, primitives, and frozen snapshots.
- `scripts/` owns deterministic build, package, native-artifact, Pi-runtime,
  workflow, and legacy-surface checks.
- `test/` contains capability-oriented suites documented in
  `docs/testing.md`.

## Runtime Boundaries

- `.nora` is the only portable document format. Do not add an importer or hidden
  fallback for older product formats.
- `out/` and `artifacts/` are generated and ignored. Do not commit generated
  bundles or VSIX files.
- The extension host logs to the Nora OutputChannel or stderr from scripts.
  Extension code must not write protocol-style data to stdout.
- Nora stores only LLM credentials in VS Code SecretStorage. Never place LLM,
  MCP, Git, header, environment, OAuth, or input secrets in `.nora`, snapshots,
  Markdown exports, fixtures, logs, or package metadata.
- Pi runs in process through the SDK. Do not add Pi RPC, bash, edit, write,
  unrestricted filesystem, package-manager, clipboard, or source-mutation tools.
- MCP servers are user-selected and may have side effects. Nora forwards bounded
  tool/resource results and does not add approval, side-effect classification,
  OAuth automation, or a read-only MCP policy.
- Git authentication belongs to system Git, SSH agents, credential helpers, and
  the user's environment. Nora stores sanitized remotes and immutable evidence,
  not credentials or clones.
- The VSIX must remain universal. Shipping architecture-neutral WebAssembly is
  allowed; platform-specific `.node`, `.so`, `.dylib`, and `.dll` runtime
  artifacts are not.

## Build and Validation

Use Node.js 24 and install without optional dependencies:

```bash
npm ci --omit=optional
npm run build
npm run check
npm test
```

Common focused commands:

```bash
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:e2e
npm run test:vscode
npm run package:vsix
npm run test:vsix
```

On Linux CI, VS Code and installed-VSIX suites run under `xvfb-run -a`. On a
desktop development machine they can run directly.

Before release-sensitive changes, also run:

```bash
node scripts/check-pi-runtime-assets.mjs
npm run check:native
npm run check:workflows
git diff --check
```

## Conventions

- Product code and copy use `Nora` and `.nora`.
- Node >= 24, plain JavaScript ES modules, and JSDoc checked by TypeScript.
- Match existing style. Keep changes surgical and avoid speculative
  abstractions.
- Read exports, direct callers, runtime validators, and nearby tests before
  changing a cross-boundary module.
- Every persistent or cross-process boundary needs runtime validation, not only
  JSDoc types.
- Tests should encode why the behavior matters. Prefer the narrowest suite that
  observes the contract.
- Product-owned SVG icons and brand marks live in `src/core/html/icons.js` and
  are rendered with `iconSvg()`. Structural document SVG remains with its owning
  feature.
- Webview and snapshot HTML must remain self-contained except for VS Code
  webview resource URIs produced by the extension host.
- Do not reintroduce removed standalone browser, external MCP host, static
  website, deployment, IndexedDB, or filesystem-product surfaces.
