# Rabbithole repository reset plan

- **Status:** in execution — Phase 0 complete; Phase 1 active
- **Nature:** temporary execution plan
- **Delete when:** Phase 3 is complete and every enduring rule has moved into
  present-tense project documentation.

This plan removes the visible history of the completed migration and fixes the
one architectural limitation that prevents clean in-document navigation: the UI
has no owned lifetime, so the web app uses a page reload as teardown. It
deliberately does not schedule a general rewrite. After this plan, product work
should pull local refactors as it touches each subsystem.

## Outcomes

At completion:

- a contributor can navigate tests by product capability rather than migration
  chronology;
- active documentation describes the system that exists now;
- switching between Rabbitholes works in-document without a page reload and
  does not accumulate UI listeners, timers, overlays, or transport
  subscriptions;
- live and frozen clients share deliberate composition without adding live-only
  code to frozen artifacts;
- persisted files, snapshots, MCP tools, and visible behavior remain compatible;
- no follow-on repository-wide refactor program is created.

## Constraints

These apply to every phase.

1. Keep `main` shippable. Each commit must pass the checks appropriate to its
   scope.
2. Preserve the public MCP contract, persisted schema, `.rabbithole` format,
   snapshot format, and existing compatibility behavior.
3. Keep JavaScript and the no-runtime-build installation model. Do not introduce
   a framework or perform a TypeScript conversion as part of this work.
4. Keep committed `dist/` artifacts and verify that they match source.
5. Keep the MCP and browser hosts distinct. Share only behavior that is actually
   common.
6. Do not delete `website/` during cleanup. The current deployment is Cloudflare
   Pages serving `publish/`, built from `web/dist` plus
   `website/public/og.jpg` and `website/public/robots.txt`. Move or delete
   website files only in a separately reviewed deploy change.
7. Do not mix mechanical renames with behavioral changes.

## Phase 0 — finish the setup-readiness feature

**Phase status:** complete in `a7e96ed`. The setup fingerprint, entry-point
gates, configured web-ingestion state, invalidation coverage, rebuilt web
artifacts, full suite, budgets, cross-browser checks, cross-host journeys, and
packaging are green.

### Goal

Close the remaining setup-readiness gap, run the complete suite, and land the
current work as an intentional product behavior before repository-wide renames.

### Work

1. Add a direct assertion that changing the configured provider, endpoint, or
   answer model makes readiness incomplete until setup is completed again. The
   fingerprint implementation already has this behavior; the missing work is
   its regression test.
2. Re-run the complete suite, including untouched stages, rather than relying
   only on the already-green modified suites.
3. Re-run packaging on the finished tree.
4. Commit the setup-readiness feature and rebuilt bundles before beginning
   Phase 1.

### Acceptance criteria

- `npm run check:types`
- `npm run build`
- `npm run check:dist`
- `npm run check:purity`
- `npm test`
- `npm run test:packaging`
- the working tree is clean after the feature commit;
- configured and unconfigured first-run behavior are both covered;
- provider, endpoint, and model changes are directly covered as readiness
  invalidators.

### Non-goals

- renaming tests;
- restructuring settings beyond what the setup flow needs;
- changing provider or credential persistence formats unnecessarily.

## Phase 1 — remove migration chronology

### Goal

Make the repository describe capabilities and current architecture rather than
the order in which they were migrated.

### Slice 1A — rename tests without editing their contents

Use `git mv` so history remains legible. A suggested destination taxonomy is:

```text
test/
  unit/
  contracts/
  integration/
  e2e/
  performance/
  packaging/
  support/
  fixtures/
  evals/
```

Suggested mappings:

| Current name | Capability name |
|---|---|
| `stage1-verify.mjs` | `unit/markdown-renderer.test.mjs` |
| `stage2-verify.mjs` | `unit/content-blocks.test.mjs` |
| `stage3-base-url-verify.mjs` | `unit/base-url.test.mjs` |
| `stage4-assets-verify.mjs` | `contracts/assets.test.mjs` |
| `stage5-pdf-verify.mjs` | `integration/pdf-ingestion.test.mjs` |
| `stage6-image-ux-verify.mjs` | `integration/image-experience.test.mjs` |
| `stage7-rearm-verify.mjs` | `integration/mcp-rearm.test.mjs` |
| `stage8-md-wire-verify.mjs` | `contracts/mcp-markdown-wire.test.mjs` |
| `stage9-store-contract.mjs` | `contracts/filesystem-store.test.mjs` |
| `stage9-idb-store-contract.mjs` | `contracts/indexeddb-store.test.mjs` |
| `stage10-web-verify.mjs` | `e2e/web-app.test.mjs` |
| `stage10x-kit-matrix.mjs` | `e2e/ui-primitives-browsers.test.mjs` |
| `stage11-web-ingest-verify.mjs` | `integration/web-ingestion.test.mjs` |
| `stage12-portability-verify.mjs` | `integration/artifact-portability.test.mjs` |
| `stage13-data-edges-verify.mjs` | `contracts/data-boundaries.test.mjs` |
| `stage13-roundtrip-verify.mjs` | `contracts/artifact-roundtrip.test.mjs` |
| `stage14-reducer-conformance.mjs` | `unit/reducer.test.mjs` |
| `stage15-security-migrations-verify.mjs` | `contracts/compatibility-security.test.mjs` |
| `stage16-budget-gauges.mjs` | `performance/budgets.test.mjs` |
| `stage17-packaging-smoke.mjs` | `packaging/install-smoke.test.mjs` |
| `stage18-generation-adapters-verify.mjs` | `integration/generation-lifecycle.test.mjs` |
| `stage19-journey-verify.mjs` | `e2e/cross-host-journey.test.mjs` |
| `fetch-proxy-worker-verify.mjs` | `contracts/fetch-proxy-worker.test.mjs` |
| `budget-measurements.mjs` | `support/budget-measurements.mjs` |
| `calibrate-budgets.mjs` | `support/calibrate-budgets.mjs` |

Adjust a proposed name if reading the test shows a different enduring owner.

Moving tests one directory deeper changes many `import.meta.url`-relative paths
to `support/`, `fixtures/`, `web/dist`, `dist/`, and repository source. Preserve
the rule that every landed commit is green:

1. first normalize shared root/path resolution where doing so can land against
   the existing layout;
2. then use `git mv` and make only the path corrections required by the move in
   the same shippable commit;
3. keep test renaming/content cleanup out of that commit.

Do not land a pure-rename commit that leaves the tests broken merely to make the
rename diff visually smaller. Review rename detection separately from the
minimal path corrections.

### Slice 1B — replace the test command surface

1. Replace `test:stageN` scripts with capability scripts:
   - `test:unit`
   - `test:contracts`
   - `test:integration`
   - `test:e2e`
   - `test:performance`
   - `test:packaging`
2. Keep `npm test` as the complete required suite.
3. Replace stage-numbered fixture titles, temporary-directory prefixes, request
   IDs, console output, and comments with descriptive names.
4. Convert `test/MANIFEST.md` into `docs/testing.md`. Keep durable scenario and
   compatibility coverage, but remove completed-phase bookkeeping and obsolete
   C3/C4 migration classifications.
5. Keep compatibility fixtures explicitly named by the historical format they
   exercise, such as schema v1 or v0.2. Compatibility history is a contract,
   not archaeology.

### Slice 1C — replace migration documentation

Create or update these present-tense documents:

- `ARCHITECTURE.md`: runtime map, dependency direction, canonical model, host
  boundaries, build artifacts, and UI ownership;
- `CONTRIBUTING.md`: setup, common commands, generated files, testing tiers,
  and change workflow;
- `docs/compatibility.md`: persisted schemas, portable files, snapshots,
  credentials, MCP version skew, and the fixture proving each promise;
- `docs/testing.md`: suite taxonomy and behavioral guarantees;
- `docs/design-system.md`: enduring rules extracted from
  `docs/architecture/CONSTITUTION.md`.

Then:

1. Delete `docs/architecture/THESEUS.md` after extracting only enduring facts.
2. Retire or replace `CONSTITUTION.md`; active design documentation must not
   refer to migration phases.
3. Fix the stale `README.md` repository-map entry. `DEPLOY.md` and the publish
   script already agree on the current pipeline: Cloudflare Pages serves
   `publish/`, built from `web/dist`, with `website/public/og.jpg` and
   `website/public/robots.txt` as live inputs. Describe that distinction without
   changing the deploy pipeline.

### Acceptance criteria

- no `test:stage*` package scripts remain;
- no stage-numbered test filenames remain;
- test output names the capability being exercised;
- active docs contain no completed Phase/Slice execution diary;
- `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/compatibility.md`, and
  `docs/testing.md` describe the current repository accurately;
- deploy documentation agrees with the actual deploy command and build inputs;
- the complete validation suite from Phase 0 remains green;
- review can distinguish pure renames from content changes by commit.

A one-time `rg` check for `stage[0-9]`, `Phase N`, and `Slice N` is part of this
phase's review. Matches are allowed only when they describe a real external
version or an intentionally historical compatibility fixture.

### Non-goals

- moving production modules;
- changing behavior to make renamed tests pass;
- deleting compatibility coverage;
- deleting or migrating the website deployment without separate verification.

## Phase 2 — give the UI an owned lifetime

### Goal

Replace the implicit module singleton with one explicitly owned UI runtime so a
Rabbithole can switch in-document without the full-page reload currently used as
the singleton's teardown mechanism. The new path must preserve the leak-free
property the reload provides today.

### Slice 2A — characterize lifecycle behavior

The real app currently calls `location.reload()` when `startHole()` sees an
already-started UI, so app-level listener and timer counts do not accumulate.
Tests that drive today's real switch path would therefore pass trivially without
characterizing the singleton problem. Before changing production structure:

1. preserve a characterization of today's persisted state and selected-hole
   behavior across the reload boundary;
2. exercise `startRabbithole()` repeatedly at the module/composition layer to
   expose the lifecycle resources that need ownership, or introduce the new
   in-document switch acceptance test alongside its implementation;
3. require the finished app to switch holes without a document navigation or
   reload;
4. prove global shortcuts fire once after repeated in-document switches;
5. prove a user action produces one transport post;
6. prove the previous transport subscription is closed;
7. prove loading/status timers do not accumulate;
8. prove active overlays, animation frames, delayed work, and per-hole asset
   resources are cancelled or released on dispose;
9. retain the existing structural guarantee that frozen startup creates no live
   transport connection.

Three sequential in-document switches are enough to expose a linear leak. A
longer soak may exist as a non-blocking diagnostic, but it is not the contract.
Do not land an intentionally red characterization commit; land the failing
probe with the smallest runtime change that makes the new contract true.

Instrumentation may wrap `addEventListener`, timers, and transport factories in
the test environment. Do not add a permanent general-purpose production test
API.

### Slice 2B — introduce the runtime boundary

Introduce a composition API shaped approximately like:

```js
const ui = createRabbitholeUi({
  root,
  hydration,
  transport,
  capabilities: {
    writable: true,
    portableExport: true,
  },
});

ui.dispose();
```

The runtime owns:

- mutable document and view state;
- DOM references;
- listener registration and removal;
- intervals, timeouts, and animation frames;
- transport connection and pending persistence work;
- overlays and their focus-restoration state;
- renderer asset URLs and other per-hole resources.

Use a small disposal stack so every resource is registered beside its creation.
Calling `dispose()` more than once must be safe.

### Slice 2C — migrate UI modules incrementally

Move modules from exported mutable globals and `register*Hooks()` toward an
explicit runtime/context, one responsibility at a time:

1. transport and status;
2. chrome and global shortcuts;
3. core state and hydration;
4. reader;
5. canvas;
6. selection and follow-ups;
7. palette and branch surfaces;
8. visuals and image resources.

Keep each intermediate commit shippable. Delete a hook registry only after its
last consumer has moved.

### Slice 2D — compose live and frozen deliberately

Use one composition model with capability differences rather than duplicated
bootstrap wiring. This does not require one identical bundle.

Frozen acceptance rules:

- no settings, provider, composer, persistence, or live transport module is
  pulled into `frozen-client.js`;
- frozen pages remain self-contained and offline;
- frozen interaction parity remains green;
- frozen bundle and snapshot sizes remain within their existing budgets;
- any intentional byte growth is measured and justified rather than hidden.

### Acceptance criteria

- switching Rabbitholes happens without `location.reload()` and disposes the
  previous UI before mounting the next;
- all lifecycle characterization tests pass;
- there is a single documented runtime ownership boundary;
- live and frozen bootstraps use the same composition vocabulary;
- no obsolete `register*Hooks()` or exported mutable DOM-state API remains;
- full validation, cross-browser checks, performance budgets, and packaging are
  green;
- persisted data, artifact bytes apart from justified build changes, MCP wire
  shapes, and visible product behavior remain compatible.

### Non-goals

- redesigning the reader or canvas;
- splitting every large file;
- rewriting the renderer;
- unifying browser and MCP host lifecycle semantics;
- introducing a component framework.

## Phase 3 — close the temporary program

### Goal

Leave behind present-tense project rules, not another completed execution diary.

### Work

1. Confirm Phases 0–2 acceptance criteria are met.
2. Move any enduring decisions discovered during implementation into
   `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/testing.md`, or
   `docs/compatibility.md`.
3. Run the narrow chronology search defined in Phase 1. This is a closure check,
   not a new general audit.
4. Delete this file.
5. Return planning attention to learning primitives and product behavior.

### Acceptance criteria

- active documentation is sufficient without this plan;
- this plan and the completed migration diary are absent from the repository;
- no follow-on repository-wide refactor roadmap has been created.

## Ongoing policy — let product work pull refactors

The following are not standalone phases. Apply them when product work enters the
relevant subsystem.

### When touching `src/web/app.js`

- extract a controller only when the feature exposes a stable responsibility;
- keep `app.js` moving toward a composition root;
- strict-check the extracted module;
- do not perform a file-size-only split.

### When touching `src/node/transport/session.js`

- separate queue, browser gateway, lifecycle, or persistence behavior only when
  the feature needs that boundary;
- bounded undo is a likely pull for document/history ownership;
- preserve MCP wait, rearm, durable-ask, and disconnect semantics.

### When touching canvas/content features

- let Walk, Play, and other learning primitives pull local `canvas-view` and
  content-layer extractions;
- keep reducer and artifact contracts host-independent;
- add strict checking to the extracted area.

### When touching styles

- move the affected subsystem toward authored CSS files that the build can
  inline into self-contained artifacts;
- preserve the single-file snapshot constraint and visual token contract;
- avoid a repository-wide CSS rewrite without a product need.

### When touching compatibility code

- identify the external artifact or stored state being supported;
- keep a named fixture proving it;
- document whether support is permanent and whether migration occurs on read or
  write;
- move compatibility behind a clearer module boundary only when the touched
  behavior makes that move useful.

### Type-checking ratchet

Expand strict `checkJs` coverage with ownership refactors, directory by
directory. A change should not create a wall of suppressions merely to claim
coverage. New or substantially rewritten modules should be strict from their
first commit.
