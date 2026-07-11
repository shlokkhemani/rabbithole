# Scenario-to-test manifest

This manifest classifies each logical test case, not each assertion. Categories are: **C1 compatibility contract** (external formats, wire protocols, migrations), **C2 behavioral product contract** (user-visible behavior changed only intentionally), **C3 implementation snapshot** (migration-disposable implementation detail), **C4 known defect** (a tripwire for behavior intended to be replaced), and **C5 design target** (new intended behavior written ahead of implementation). C4 cases are deliberately marked so they never become golden truth. Update this file whenever a test case is added, removed, split, renamed, or materially changed.

Scenario references use the Part VI group and shortened ledger wording. `—` means the case protects behavior outside the current ledger. Cases in the unwired eval are inventoried even though `npm test` does not run them.

## `stage1-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| all four math delimiters | C2 | Defines supported math syntax. | Rendering: KaTeX parse errors (happy-path side) |
| inline dollar boundary rules reject prices and spacing | C2 | Protects user-visible math parsing rules. | — |
| code spans shield dollars | C2 | Protects markdown/code interaction. | — |
| highlight known languages and keep unknown plain | C2 | Defines highlighting and fallback behavior. | Rendering: unknown fence language |
| math inside lists and blockquotes | C2 | Protects composed markdown rendering. | — |
| bad TeX falls back to source code | C2 | Defines recoverable inline math errors. | Rendering: KaTeX parse errors |
| unclosed display math is pending and source is held | C2 | Defines streaming-pending presentation. | Rendering: unclosed fence mid-stream (math analogue) |
| raw HTML remains escaped | C2 | Protects rendered-content safety. | Rendering: injection via imported/rendered payloads (raw-HTML subset) |
| live/export page assembly and KaTeX bundling | C3 | Pins bundling counts, hydration keys, and transport strings rather than only semantics. | Rendering: frozen viewing fully offline (structural evidence only) |

## `stage2-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| visual placeholders, pending show/math, raw HTML escaping | C2 | Defines visible pending and safe markdown behavior. | Rendering: unclosed fence mid-stream; injection via fences/imported payloads (raw-HTML subset) |
| visual mount identity/cache pruning | C3 | Pins the current cache-and-replace implementation. | — |
| visual sanitizer policy and leading styles | C2 | Protects the `show` security policy and allowed styling. | Rendering: injection via fences/imported payloads (live path) |
| DOMPurify/page assembly order and script parse | C3 | Pins one-script assembly and library placement. | — |

## `stage3-base-url-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| explicit markdown URL resolution and sanitizer gates | C2 | Defines link/image resolution and unsafe-URL rejection. | Rendering: injection via fences/imported payloads (URL subset) |
| GitHub image raw rewrite | C2 | Protects user-visible GitHub rendering/link behavior. | — |
| frontmatter inference and precedence | C2 | Defines source/base URL semantics. | — |
| child inheritance, streaming fallback, frontmatter upgrade | C2 | Protects base URLs across branch streaming. | — |
| legacy resume backfill persists inferred fields | C1 | A persisted legacy document migration must remain readable and idempotent. | Migration/deploy: new code, old storage/idempotent migrations (filesystem projection) |
| MCP tool validation rejects invalid `base_url` | C1 | Protects the public MCP input boundary. | Migration/deploy: CLI version skew (validation compatibility subset) |

## `stage4-assets-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| asset storage copy/overwrite/delete and validation | C1 | Protects persisted asset operations and the 20 MB limit. | Data: 20MB asset boundary (over-limit side only); malformed JSON/base64 (asset-name/path subset only) |
| markdown asset images/link rejection/base isolation | C2 | Defines visible asset-reference rendering. | Data: missing asset (rejection behavior, not frozen `data:,` fallback) |
| MCP asset manifest validation | C1 | Protects public tool shapes and validation. | Migration/deploy: CLI version skew (additive-wire subset) |
| asset route safety, export inlining, and SSE progress | C1 | Spans live routes, portable frozen assets, and MCP event payloads. | Rendering: frozen viewing fully offline (structural); Generation: durable streaming wire (happy path) |

## `stage5-pdf-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| PDF happy path: staged PNGs, manifest, and text | C2 | Protects the PDF-ingest product flow. | — |
| PDF page range and `include_text=false` | C2 | Defines user-facing ingest options. | — |
| staged assets adopted by `open_rabbithole` | C1 | Protects MCP staging and adoption contracts. | — |
| direct `hole_id` ingestion | C1 | Protects direct persisted asset ingestion. | — |
| invalid PDF/path/ingest/range/hole-id rejection | C1 | Protects trust-boundary validation. | Data: malformed JSON/base64 (malformed-input analogue only) |
| optional real-paper performance/quality probe | C3 | Environment-specific timing/size observations have no enforced budget. | Data: very large holes (weak proxy only) |

## `stage6-image-ux-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| plain markdown images and show placeholders | C2 | Defines which images receive document image UX. | — |
| served/export image UX source and CSS sentinels | C3 | Searches function names, formulas, zoom constants, and selectors rather than behavior. | Rendering: dark parity (CSS-presence subset only) |

## `stage7-rearm-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| keep-listening shape, grace, live reattach, waiter cleanup | C1 | Protects frozen MCP lifecycle responses and reattachment. | Migration/deploy: CLI version skew; Generation: abort mid-stream (MCP waiter cancellation only) |
| saved pending ask requeues once after resume | C1 | Protects MCP durable-ask/rehydration semantics. | Generation: error mid-stream → durable ask per host semantics (MCP re-ask behavior, without inducing an error) |

## `stage8-md-wire-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| renderer fixture: math | C2 | Protects shared math output. | Rendering: KaTeX parse errors (happy-path side) |
| renderer fixture: code | C2 | Protects shared code highlighting. | — |
| renderer fixture: show fence | C2 | Protects shared hydratable-block placeholders. | — |
| renderer fixture: asset reference | C2 | Protects shared asset URL resolution. | — |
| renderer fixture: hostile raw HTML | C2 | Protects raw-HTML escaping. | Rendering: injection via fences/imported payloads (raw-HTML subset) |
| renderer fixture: JavaScript links | C2 | Protects unsafe-link stripping. | Rendering: injection via fences/imported payloads (URL subset) |
| browser-bundle renderer sentinel | C3 | Pins a literal implementation marker. | — |
| markdown-only hydration/SSE and absence of `contentHtml` | C3 | Pins the current projection/event representation. | — |
| MCP tool response shapes and late-answer closure | C1 | Protects public MCP response/event shapes. | Migration/deploy: CLI version skew |
| partial-to-final streaming accumulation | C2 | Protects observable streaming completion. | Generation: durable streaming happy path |
| frozen export assets and renderer capabilities | C2 | Protects frozen rendering of math/code/show/assets. | Rendering: frozen viewing fully offline (structural evidence only) |

## `stage9-store-contract.mjs` (filesystem store)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| hole save/load/list/delete and schema stamping | C1 | Defines the filesystem store contract. | — |
| v0.2 fixture migrates, saves, reloads as schema v1 | C1 | Protects persisted legacy migration. | Migration/deploy: new code, old storage/idempotent migrations (filesystem) |
| asset put/get/list/delete | C1 | Defines persisted asset operations. | — |
| staging create/put/adopt | C1 | Defines PDF staging operations. | — |
| bad IDs/names/traversal rejected | C1 | Protects storage trust boundaries. | — |
| shared asset GC and final-reference deletion | C2 | Protects deletion asset semantics. | — |

## `stage9-idb-store-contract.mjs` (IndexedDB store)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| hole save/load/list/delete and schema stamping | C1 | Defines the browser store contract. | — |
| v0.2 fixture migrates, saves, reloads as schema v1 | C1 | Protects old IndexedDB data under new code. | Migration/deploy: new code, old IndexedDB/idempotent migrations |
| asset put/get/list/delete | C1 | Defines browser binary-asset operations. | — |
| staging create/put/adopt | C1 | Defines browser PDF staging operations. | — |
| bad IDs/names/traversal rejected | C1 | Protects browser storage trust boundaries. | — |
| shared asset GC and final-reference deletion | C2 | Protects deletion asset semantics. | — |

`support/store-contract.mjs` is an unwired helper, not an independently executed suite; its six exported cases are the six rows instantiated for each Stage 9 backend above.

## `stage10-web-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| calm landing, three-path composer, path copy, dismiss-without-create | C2 | Protects first-run navigation and empty state. | — |
| blank-state centering and composer initial focus | C2 | Protects visible placement and initial keyboard focus. | Chrome: keyboard-only completion (small opening/closing subset) |
| Dialog composer containment, dismissal, and restoration | C2 | Requires live-content Tab/Shift+Tab wrapping, enforced modal labeling, Escape and backdrop dismissal, and deterministic toolbar/N-trigger focus restoration while first-visit auto-open remains triggerless-safe. | Chrome: keyboard-only completion; focus restoration after transient surfaces; outside-pointer dismissal |
| toolbar Button kit conformance | C2 | Requires every reader/canvas toolbar button to declare `type="button"` and expose a non-empty accessible name. | Chrome: toolbar accessibility |
| Notice timer replacement, hover pause, live regions, and banner dismiss | C2 | Requires one wired-shell Notice contract to replace timers without early hiding, pause timed feedback during interaction, announce politely, and dismiss persistent banners. | Chrome: transient feedback accessibility |
| reader/canvas toolbar keyboard activation and focus-visible rings | C2 | Exercises Enter/Space activation across both modes and requires the constitutional keyboard-only ring on both toolbar families. | Chrome: keyboard-only completion; focus visibility |
| warm re-entry, hash precedence, rail delete fallback, and Undo | C2 | Protects saved-hole navigation, recovery, and actionable-toast restoration. | — |
| first ask key validation and streamed root creation | C2 | Protects BYOK first-run streaming behavior. | Generation: 401/403 (pre-stream validation only); title never arrives (non-sentinel root title path only) |
| rail content/geometry exact values | C4 | Pins the Phase 2 semantic rail width, panel padding, and symmetric row-padding geometry. | — |
| keyboard-opened rail holds focus without a container ring; Escape closes only the rail | C2 | Focus policy: the panel takes focus so keys flow into rows, container emphasis must not impersonate the keyboard ring (was a UA `outline: auto` around the whole panel), and Escape must not fall through to the canvas client's open-the-reader shortcut (it did — the rail handler leaked propagation). | Chrome: keyboard-only completion (rail subset) |
| credentials stay isolated from holes/snapshots | C1 | Protects the no-export credential contract. | Data: preference/credential storage (isolation only, not migrations) |
| web snapshot export ships an empty style block | C4 | Records that web-exported frozen HTML is unstyled (`snapshot.js` serializes the page's inline `<style>`, which the web build does not emit; the styled export path lives in the canvas host). Phase 7's snapshot boundary fixes this and retires the tripwire. | Data: snapshot export styling |
| owned provider Select ARIA, keyboard, token anchor, nested Escape, and focus restoration | C2 | Pins the single-select trigger/listbox contract, roving option focus, token-derived anchoring, child-before-parent dismissal, and focus continuity (`stage10-web-verify.mjs:262-292`, `stage10-web-verify.mjs:331-334`). | Chrome: anchored transient surfaces; keyboard-only completion; focus restoration |
| provider switch preserves conditional settings and provider-local credentials | C2 | Preserves live provider persistence and the Local/OpenRouter conditional settings surfaces through the owned Select. | Chrome: settings during active stream (no active stream) |
| OpenRouter Combobox ARIA, keyboard, token anchor, focus, and designed async states | C2 | Pins the editable-combobox/listbox/option contract, `aria-activedescendant` navigation with input focus retained, token-derived anchoring, loading/empty/error-retry states, exact-id fallback, dual model commit, and trigger focus restoration. | Chrome: Combobox catalogs; anchored transient surfaces; keyboard-only completion; focus restoration |
| Local Ollama discovery Combobox found/none/error-retry/exact-id states | C2 | Requires discovery to start only on open, calmly explains an empty installation with the `ollama list` hint, recovers failed fetches, preserves free text, and dual-writes the chosen model. | Chrome: Combobox catalogs; keyboard-only completion |
| inline key-panel eye toggle | C2 | Guards the inline `renderInlineKeyPanel` Field wiring by requiring password/text and `aria-pressed` to change together (`stage10-web-verify.mjs:151-158`). | Chrome: credential entry and accessible state |
| settings Field names and described-by connections | C2 | Requires all five remaining settings text/password inputs to expose labels and resolvable hint or status descriptions. | Chrome: keyboard-only completion (settings field accessibility) |
| API key Field live status remains functional | C2 | Preserves the polite live-region contract through validation and its successful asynchronous update (`stage10-web-verify.mjs:466`, `stage10-web-verify.mjs:498-501`). | Data: preference/credential storage (status only) |
| Field halo and focus-visible-only keyboard ring | C2 | Enforces pointer focus without a keyboard ring, composite field halo emphasis, and keyboard-visible focus (`stage10-web-verify.mjs:467-483`). | Chrome: keyboard-only completion (settings focus treatment) |
| session-only key opt-out | C2 | Protects credential persistence choice. | Data: preference/credential storage (current behavior only) |
| settings anchor uses token gap/edge, flips, and repositions after content growth | C2 | Enforces the shared measure-flip-clamp engine and token-derived trigger-relative geometry (`stage10-web-verify.mjs:364-420`). | Chrome: anchored surfaces at viewport edges; content changes after open |
| nested settings layers close top-first on Escape | C2 | Enforces Combobox-before-settings stack ordering without a consumer-owned closing seam and prevents Escape from leaking to lower canvas shortcuts. | Chrome: nested transient surfaces; keyboard-only completion |
| settings Escape/outside-pointer restore trigger focus | C2 | Enforces visible focus continuity for both stack dismissal paths (`stage10-web-verify.mjs:450-458`). | Chrome: focus restoration after transient surfaces |
| provider switch preserves trigger identity and keyboard focus | C2 | Requires the persistent provider row to retain `document.activeElement` while only conditional endpoint/model/key sections rerender, without product refocusing. | Chrome: settings provider-switch focus continuity |
| keyboard-only settings round trip | C2 | Opens from the toolbar, reaches provider/model controls, switches provider, commits a model, and Escapes with focus restored to the settings trigger. | Chrome: keyboard-only completion of settings |
| settings surface lifetime follows the interaction | C2 | Requires both Escape and outside-pointer dismissal to remove the body-appended settings surface from the DOM. | Chrome: transient surface lifetime |
| settings trigger ARIA follows live surface state | C2 | Requires `aria-expanded` true/false synchronization and an `aria-controls` reference only while the controlled surface exists. | Chrome: settings trigger accessibility |
| live math/code/show document rendering | C2 | Protects core authoring rendering. | — |
| lightbox Dialog Escape/backdrop dismissal and source-image focus restoration | C2 | Requires the dynamic image preview to use the shared Dialog lifecycle while preserving surround-only dismissal and deterministic focus continuity. | Chrome: keyboard-only completion; focus restoration after transient surfaces; outside-pointer dismissal |
| palette Dialog keyboard, listbox, active-descendant, and Escape isolation contract | C2 | Requires shortcut opening, type filtering, Arrow/Enter commit, input-retained focus, synchronized option selection, and layer-owned Escape that cannot reach the canvas reader shortcut. | Chrome: keyboard-only completion; focus restoration after transient surfaces |
| frozen palette and lightbox Dialog smoke | C2 | Requires both shared canvas-client modal paths to remain initialized and dismissible in self-contained snapshots. | Rendering: frozen viewing control parity; Chrome: keyboard-only completion |
| share popover token anchor geometry, surface/padding, and focus restore | C2 | Enforces shared-engine trigger-relative placement and stack focus restoration while retaining the shared surface metrics (`stage10-web-verify.mjs:486-526`). | Chrome: anchored surfaces at viewport edges; focus restoration after transient surfaces |
| share menu keyboard contract | C2 | Requires keyboard-invoked initial focus, a single roving Tab stop, wrapped Arrow navigation, Home/End, activation, Tab departure, and layer-owned Escape restoration. | Chrome: keyboard-only completion; focus restoration after transient surfaces |
| frozen share menu suppression and traversal | C2 | Requires frozen snapshots to omit export/portable/synthesis from both presentation and the keyboard traversal set. | Rendering: frozen viewing control parity; Chrome: keyboard-only completion |
| delete confirmation Popover anchor and dismissal contract | C2 | Requires token-gap anchoring, Keep initial focus, layer-owned Escape/outside-pointer dismissal with delete-control focus restoration, and keyboard Remove activation. | Chrome: anchored transient surfaces; keyboard-only completion; focus restoration after transient surfaces |
| branch-mark link semantics and keyboard navigation | C2 | Requires shared reader/canvas marks to be Tab-reachable links named from the settled branch title, with Enter opening the branch. | Chrome: keyboard-only completion; Rendering: shared live/frozen controls |
| breadcrumb landmark, keyboard navigation, and node reuse | C2 | Requires ancestor crumbs to be Enter-operable links, the current crumb to be non-focusable and current, and lineage rerenders to preserve crumb identity. | Chrome: keyboard-only completion; Rendering: shared live/frozen controls |
| sidebar branch link semantics, streaming patch, and node reuse | C2 | Requires named tabbable branch links, Enter navigation, and streamed pending-to-settled updates without replacing reusable tiles. | Chrome: keyboard-only completion; Generation: durable streaming; Rendering: shared live/frozen controls |
| linked reader-context keyboard jump | C2 | Requires the original-context strip to expose named link semantics and Enter to retain the existing origin jump and flash. | Chrome: keyboard-only completion; focus visibility |
| frozen reader breadcrumb and sidebar keyboard parity | C2 | Requires frozen pages to retain breadcrumb and sidebar Enter navigation without adding snapshot-only affordances. | Rendering: frozen viewing control parity; Chrome: keyboard-only completion |
| branch peek non-modal Popover behavior | C2 | Requires hover/focus delayed opening, blur/mouseout dismissal, isolated Escape, stable-shell content patching, token flip/clamp anchoring, no focus theft, and frozen parity. | Chrome: anchored transient surfaces; keyboard-only completion; Rendering: frozen viewing control parity |
| selection-bar virtual anchor placement | C2 | Requires token-gap flip/clamp placement from a live Range at viewport edges and a non-focus-stealing open. | Chrome: anchored surfaces at viewport edges |
| selection-bar Escape isolation | C2 | Requires layer-owned Escape to preserve the live selection, focus the owning card/reader container, and prevent propagation to canvas shortcuts. | Chrome: keyboard-only completion; focus restoration after transient surfaces |
| selection-bar keyboard round trip | C2 | Requires Tab entry into the question box, typed question input, and Enter submission. | Chrome: keyboard-only completion |
| card header control semantics | C2 | Requires all five per-card controls to declare `type="button"`, expose their specified accessible names, and remain excluded from card dragging. | Chrome: toolbar accessibility; pointer gesture isolation |
| card drawer disclosure contract | C2 | Requires resolvable `aria-controls`, synchronized `aria-expanded`, isolated Escape with focus returned to the owning handle, unchanged canvas mode, and preserved empty-draft blur dismissal. | Chrome: keyboard-only completion; focus restoration after disclosures |
| card drawer keyboard round trip | C2 | Opens the embedded disclosure from its handle, types and submits a question with Enter, spawns the follow-up child through the existing request path, and closes after submission. | Chrome: keyboard-only completion; Generation: follow-up submission |
| selection branch streams and titles | C2 | Protects selection-to-branch generation. | Generation: title never arrives (sentinel success only) |
| reader whole-document follow-up | C2 | Protects document chat branching. | — |
| streamed branches persist across reload; external request allowlist | C2 | Protects save/re-entry and network scope. | Generation: tab close mid-stream (post-completion reload only) |

## `stage10x-kit-matrix.mjs` (Chromium, Firefox, WebKit)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| Layer stack Escape, outside pointer, stacking, and focus restore | C2 | Runs the shared dismissal ordering and focus-continuity contract in all supported engines. | Chrome: nested transient surfaces; focus restoration after transient surfaces; outside-pointer dismissal |
| Anchor element/virtual placement, token gap, flip, and clamp | C2 | Runs both anchor shapes through the shared token geometry in all supported engines. | Chrome: anchored transient surfaces |
| Popover trigger semantics, initial focus, Escape, and restore | C2 | Pins the composed Popover contract independently of app consumers in all supported engines. | Chrome: keyboard-only completion; focus restoration after transient surfaces |
| Dialog labeling, initial focus, Tab containment, backdrop close, and restore | C2 | Pins modal accessibility and lifecycle behavior in all supported engines. | Chrome: keyboard-only completion; focus restoration after transient surfaces; outside-pointer dismissal |
| Notice variant wiring and timer pause/resume | C2 | Pins live-region semantics and interaction-safe timing in all supported engines. | Chrome: transient feedback accessibility |
| Select keyboard open and commit | C2 | Pins the owned single-select keyboard contract in all supported engines. | Chrome: keyboard-only completion |
| Combobox input semantics, filter, and keyboard commit | C2 | Pins the owned editable-combobox contract in all supported engines. | Chrome: Combobox catalogs; keyboard-only completion |
| Field description and password-toggle synchronization | C2 | Pins accessible descriptions and visible/pressed state in all supported engines. | Chrome: credential entry and accessible state |
| Button and IconButton type/name enforcement | C2 | Pins safe button defaults and icon accessible-name enforcement in all supported engines. | Chrome: toolbar accessibility |

## `fetch-proxy-worker-verify.mjs` (run by Stage 11)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| reject non-GET requests | C2 | Defines relay access policy. | — |
| reject unallowlisted hosts | C2 | Defines relay host policy. | — |
| strip request/response credentials and preserve CORS/content | C2 | Protects proxy security behavior. | — |
| enforce streaming 25 MB response cap | C2 | Protects resource limits while streaming. | — |

## `stage11-web-ingest-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| browser PDF ingest is local and stores rendered pages/text | C2 | Protects offline browser PDF ingestion. | — |
| arXiv direct-fetch failure falls back to configured proxy | C2 | Protects URL/arXiv recovery behavior. | — |
| dead proxy produces actionable recovery copy | C2 | Protects designed ingest failure recovery. | — |
| relay rejection produces arXiv-specific guidance | C2 | Protects designed unsupported-host recovery. | — |

## `stage12-portability-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| shell/settings polish and owned provider Select switching | C2 | Verifies the portable shell drives provider changes through the owned keyboard Select without pinning native-control geometry (`stage12-portability-verify.mjs:171-202`). | Chrome: keyboard-only completion |
| improve-structure invokes author stream once | C2 | Protects document authoring generation. | — |
| PDF-backed `.rabbithole` export shape and credential exclusion | C1 | Protects the portable format and secret isolation. | Data: preference/credential storage (isolation only) |
| rail export filename | C2 | Protects user-visible download behavior. | — |
| portable import recreates document and binary asset | C1 | Protects cross-context portable import/export. | Data: import ID collision (fresh import only; no collision) |
| publish artifact files, redirects, and public copy | C1 | Protects deployment/package website output and URLs. | Migration/deploy: URLs/deploy compatibility (outside the four named ledger cases) |

## `stage13-data-edges-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| future format_version is clearly refused | C1 | Protects the public portable-file version boundary and its recoverable refusal. | Data: future `format_version` clear refusal |
| future schema_version is legibly refused | C1 | Ensures old builds refuse unknown persisted schemas instead of silently dropping fields. | Data: new-format document through an old build refuses; future schema version |
| schema_version null backfills, persists, and reloads | C1 | Protects forever-readable legacy files and idempotent migration through the filesystem store. | Data: `schema_version: null` legacy backfill; Migration/deploy: old storage/idempotent migrations |
| malformed JSON, base64, and wrong-type fields reject without crashing | C1 | Exercises portable and schema trust boundaries with representative malformed inputs. | Data: malformed JSON/base64; hand-edited payload types |
| unicode, emoji, and RTL titles survive validate-persist-reload | C1 | Protects lossless international text across validation and filesystem persistence. | Data: unicode/emoji/RTL titles |
| hand-edited snapshot payload validation | C4 | Records that current snapshots have no import validator or size cap; skipped until the Phase 7 snapshot boundary exists. | Data: hand-edited snapshot payloads |
| exact 20 MB asset is accepted and one byte over is rejected | C1 | Pins both sides of the documented per-asset byte boundary using generated data. | Data: 20MB asset boundary |

## `stage13-roundtrip-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| all corpus fixtures are normalized fixed points and export-idempotent | C1 | Protects portable migration, assets, durable asks, and filesystem persistence across repeated import/export projections. Exports are anchored to the source file (not merely to each other), so a field silently dropped by the export path cannot cancel out; the two legacy fixtures are exempt from source-anchoring because import deliberately migrates them. | Data: portable compatibility; `schema_version: null`; unicode/emoji/RTL; very wide holes; durable asks per host semantics |
| import collision mints a fresh hole_id and preserves content | C1 | Protects collision-safe identity generation without content or asset loss. | Data: import ID collision |

## `stage14-reducer-conformance.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| branch_request happy path | C2 | Pending branch construction and URL inheritance are observable document behavior. | — |
| branch_request missing parent throws | C2 | Invalid branch requests must fail rather than create detached nodes. | — |
| branch_request missing node_id throws | C2 | Branch nodes require stable identity. | — |
| node_progress grows then idempotently replays | C2 | Full-markdown replacement and same-text replay define current streaming behavior. | Generation: durable streaming (reducer side) |
| stale node_progress currently wins | C4 | Records the acknowledged lack of `{id, seq}` ordering without blessing it as product behavior; retired by the Phase 5/6 order guard. | Generation: stale progress after newer progress |
| node_answered updates existing pending node | C2 | Completing an existing pending node is core generation behavior. | — |
| node_answered synthesizes unknown node | C2 | Final answers may materialize a node when no pending node exists. | — |
| delete_node subtree collection and effects | C2 | Deletion must remove descendants and return sufficient effect data for consumers. | — |
| delete_node explicit node_ids and effects | C2 | Explicit deletion lists are part of reducer behavior and effect reporting. | — |
| root delete throws | C2 | The starting document is protected from node deletion. | — |
| node_update and nodes_update field application | C2 | Supported presentation fields must normalize consistently while unknown nodes remain untouched. | — |
| view_state normalization | C2 | Persisted navigation state has a normalized shape and bounded camera scale. | — |
| unknown event type throws | C2 | Unsupported vocabulary must fail explicitly rather than silently diverge. | — |
| prior-state node mutation probe | C3 | Measurement point for the Phase 5 purity decision; shared-node mutation is explicitly not a product contract. | — |
| Node/Chromium reducer parity | C2 | The deterministic DOM-free reducer must produce identical projections in both supported execution contexts. | — |

## `stage15-security-migrations-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| imported and show-fence injection on live/frozen paths | C2 | Protects the user-visible security boundary for imported markdown and hydratable show content, including script, iframe, handler, JavaScript-URL, and SVG vectors. | Rendering: script/iframe/handler injection via fences and imported payloads, both paths |
| KaTeX errors and trusted structural markup | C2 | Requires invalid math to degrade safely while valid KaTeX MathML, semantics, annotations, and fraction structure survive both render paths. | Rendering: KaTeX parse errors; trusted MathML sanitizer parity |
| frozen asset-bearing document with all requests blocked | C1 | Frozen snapshots are a self-contained external artifact and must render their document and embedded assets without attempting network access. | Rendering: frozen viewing fully offline, zero fetches |
| frozen toolbar render and Done/activity suppression | C2 | Requires shared toolbar markup to survive snapshot assembly while preserving frozen-only control suppression. | Rendering: frozen viewing control parity |
| current provider-key map canonical cleanup (`stage15-security-migrations-verify.mjs:150-153`) | C1 | Preserves current settings and key-map data while removing the retired single-key slot. | Data: preference/credential storage through every migration |
| single-key-era credential adoption (`stage15-security-migrations-verify.mjs:156-159`) | C1 | Requires lossless adoption into the provider-key map and retirement of the legacy slot. | Data: preference/credential storage through every migration |
| pre-popover custom/local canonical migration (`stage15-security-migrations-verify.mjs:162-165`) | C1 | Preserves local settings and session-only choice while adopting the stray OpenRouter-era credential without assigning it to Local. | Data: preference/credential storage through every migration |
| removed Anthropic/OpenAI provider canonical rewrite (`stage15-security-migrations-verify.mjs:168-177`) | C1 | Requires aliases to rewrite to OpenRouter defaults while preserving unrelated preferences and credentials. | Data: preference/credential storage through every migration; provider-id renames |
| malformed settings and credential-map normalization (`stage15-security-migrations-verify.mjs:180-187`) | C1 | Invalid settings JSON loads canonical defaults and an array key map normalizes to empty without throwing. | Data: malformed JSON/hand-edited preference storage; Migration/deploy: idempotent migrations |
| preference migration/load idempotence | C1 | Repeated application loads must not drift settings, credential keys, theme, or last-hole state. | Migration/deploy: new code opening old storage, idempotent migrations |
| credential exclusion from frozen exports | C1 | Device credentials and settings must never enter exported artifacts. | Data: preference/credential storage through every migration; artifact credential non-leakage |
| portable-import asset MIME metadata loss | C4 | Pins the known defect where base64 import creates an untyped Blob, preventing direct frozen reuse without a typed ingest asset. | Rendering: frozen viewing fully offline; Data: portable asset migration |

## `stage16-budget-gauges.mjs`

Gauges are machine-relative: `test/budgets.json` records `{baseline, tolerance, ceiling, rationale, measured_at_commit}` per gauge; `node test/calibrate-budgets.mjs` re-baselines deliberately. Any worsening requires an explicit recorded trade-off (THESEUS Part III).

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| live + frozen client bundle byte gauges | C3 | Bundle sizes are implementation-relative; the ratcheted ceiling catches accidental bloat without blessing current size as a contract. | Data: bundle-size budget |
| snapshot byte gauges (math + asset reference corpus) | C2 | Frozen HTML is a user-shared artifact; its size envelope for reference content is product behavior. | Data: snapshot bytes budget |
| snapshot build-time gauges | C2 | Export must stay interactive-fast for reference content; min-of-samples with 3x ceiling absorbs host noise. | Data: snapshot build-time budget |
| cold-open gauge | C2 | Time to the visible interactive landing composer is the first-load product experience. | Rendering: cold open budget |
| streaming DOM batch count + duration gauges | C2 | A fixed 40-update synthetic stream must stay rAF-coalesced; losing batching is a user-visible regression. | Generation: streaming update budget (rAF count/duration) |
| save-window gauge | C2 | Elapsed time from final streamed update to persisted markdown bounds the data-loss window on tab close. | Data: export-vs-debounce save window (web path) |

## Unwired: `evals/run-eval.mjs`

These live-provider eval cases run only through `npm run eval`; their regex/heuristic scoring makes them behavioral probes, not deterministic golden masters.

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| `math_derivation` | C2 | Evaluates useful, parseable math output. | Rendering: KaTeX parse errors (generated-source side) |
| `diagram_show` | C2 | Evaluates safe generated `show` content. | Rendering: injection via fences (generated-output side) |
| `eli5_lens` | C2 | Evaluates ELI5 lens behavior. | — |
| `example_lens` | C2 | Evaluates example lens behavior. | — |
| `deeper_lens` | C2 | Evaluates deeper lens behavior. | — |
| `code_explain` | C2 | Evaluates code-aware answers. | — |
| `empty_followup` | C2 | Evaluates a follow-up with empty selection, not an empty provider answer. | — |
| `synthesis` | C2 | Evaluates synthesis across nodes. | — |
| `long_doc_pack` | C2 | Evaluates answer length on a long context. | Data: very large holes (content-quality proxy only) |
| `title_sentinel` | C3 | Pins the current sentinel protocol Phase 6 contains and may later retire. | Generation: title never arrives (success side only) |
| `hostile_selection` | C2 | Evaluates safety under prompt-like selected text. | Rendering: injection via imported payloads (model-output side only) |
| `plain_factual` | C2 | Evaluates baseline factual response quality. | — |

## Counts

Counts treat each row above as one case; the shared Stage 9 contract counts once per backend because `npm test` executes it against both.

| Category | Count |
|---|---:|
| C1 compatibility contract | 41 |
| C2 behavioral product contract | 128 |
| C3 implementation snapshot | 10 |
| C4 known defect | 5 |
| C5 design target | 0 |
| **Total** | **184** |

## Known-defect fossils

- `stage10-web-verify.mjs:179-224` pins rail padding (`12px`, `7px`, `8px`), bottom gap (`14px`), and width (`<=226px`): per-screen magic design values Phase 2 intends to centralize.
- `stage10-web-verify.mjs:421-442` retains settings surface equality and the optical gear offset; `stage10-web-verify.mjs:486-521` retains share surface equality and exact shell/item padding. Anchoring itself is now a C2 engine contract rather than a bespoke-geometry fossil.
- No assertion requires settings `innerHTML` rebuilding or focus-hunting. `stage2-verify.mjs:253-271` does rebuild a synthetic content container via `innerHTML`, but its asserted contract is visual mount identity/cache behavior, not that settings/chrome must rebuild. No current case asserts focus restoration after settings close, so the bespoke focus-hunting debt is unprotected rather than fossilized.
- `stage14-reducer-conformance.mjs` "stale node_progress currently wins" pins last-write-wins progress ordering — the gap the `{id, seq}` order guard (Phases 5/6) closes.
- `stage13-data-edges-verify.mjs` "hand-edited snapshot payload validation" is a skip-with-reason: snapshots currently have no inert import boundary, validator, or size cap (built in Phase 7).

## Baseline defects on record (found by instruments, not fixed)

- `FsStore.getAsset()` returns a `Buffer`, but `buildRabbitholeExport()` assumes Blob and calls `blob.arrayBuffer()` (`src/web/portable.js:139`) — exporting an asset-bearing hole directly from the filesystem store throws. Unreachable in today's product (web export runs against the IDB store, which returns Blobs), but it is a store-port contract violation; the typed store port (Phase 5) and artifact unification (Phase 7) must resolve it. stage13's round-trip test documents this with a test-local Blob-converting subclass.
- `base64ToBlob()` (`src/web/portable.js`) creates an untyped Blob, so a directly imported asset snapshots to an `application/octet-stream` data URL that the frozen image sanitizer rejects. Typed asset handling lands with the store port (Phase 5) / artifact unification (Phase 7). Pinned as C4 in stage15.
- Web-exported frozen snapshots carry no styles at all: `buildSnapshotHtml()` (`src/ui/snapshot.js:145`) serializes the page's first inline `<style>`, which exists in the canvas host (`src/node/html/canvas.js:30-33` inlines `CANVAS_STYLES` + KaTeX) but not in the web build, whose CSS arrives via an external `<link>`. Discovered during Phase 2 slice B review when an attempted inline-style injection moved the snapshot byte gauge +51KB. Fix lands with the Phase 7 snapshot boundary (styled, self-contained web exports incl. KaTeX) plus a snapshot-budget recalibration. Pinned as C4 in stage10.

## Smoke-detector proof (Phase 1 exit criterion)

Run at commit 0853e1b (2026-07-10): five deliberate regressions, one per instrument class, each planted in `src/` and reverted after the verdict.

- Reducer semantics (node_progress append instead of replace) → **caught** by stage14 goldens.
- Export field drop (`font_scale` removed from the persisted projection) → **initially missed**: the round-trip test compared exports only against other exports, so the drop cancelled out. Fixed by anchoring `export(import(source))` to the source file; the re-planted regression now fails on the first fixture.
- Sanitizer loosening (event handlers allowed through show fences) → **caught** by stage15.
- Theme restoration ignored on load → **caught** by stage15's migration fixtures.
- 100 KiB bundle bloat → **caught** by stage16's `bundle_client_bytes` ceiling.

## Gap analysis

### Scenario-ledger entries with no covering test

“No covering test” means no case directly drives the stated scenario end to end; happy-path, structural, or analogous checks noted in tables do not count. Ordered by the phase that first needs the gap.

**Phase 1 — instruments/data/security baseline** (most entries closed by stages 13–16; remaining:)

- Data: genuinely very large holes with a budget (the wide-hole fixture and snapshot gauges only cover reference-sized content); extension-bag survival through an old build (refusal is covered; survival semantics await Phase 5 typing); hand-edited snapshot payload runtime rejection (C4 skip until the Phase 7 import boundary); export-vs-debounce timing for the MCP/filesystem projection (stage16's save-window gauge covers the web path only).
- Rendering: reduced motion; semantic dark parity.
- Migration/deploy: a real mid-session deploy (new code opening old IndexedDB, with migration rerun/idempotence — stage15 covers localStorage preferences, not the IDB schema during a live session); CLI version skew with an older CLI against additive wire changes; `npx` publish-install smoke on Node 18 and 20; a v0.1-era hole retained through Phase 9.

**Phase 3 — settings vertical slice**

- Chrome: focus restoration on every overlay close; Escape/outside-click ordering with stacked overlays; anchored surfaces at every viewport edge; keyboard-only completion of every manifest flow; settings opened/changed during an active stream; Combobox behavior for slow, failed, and empty catalogs.

**Phase 6 — generation normalization**

- Generation: real stream abort; error mid-stream with browser-partial persistence and MCP-partial dropping/re-ask; stale progress after newer `{id,seq}` progress; empty provider answer; missing title fallback; N concurrent streams; delete while streaming; provider/model switch mid-stream; 401/403 during a stream with prompt-and-retry closure; rate limits; tab close mid-stream bounded by the save budget.

**Phase 7 — artifacts**

- Data: actual import-ID collision producing a fresh ID; frozen missing-asset `data:,` fallback. These belong with Phase 1 fixtures but become release gates no later than artifact unification.

### Part III instruments

| Instrument | Assessment | Evidence / missing work | First needed |
|---|---|---|---|
| Fixture corpus | **Exists** | `test/fixtures/corpus/` holds 20 curated files (math, show, assets, deep lineage, both durable-ask semantics, Unicode/RTL, `schema_version:null`, v0.2 legacy, wide holes) plus the in-test generated 20 MB boundary; stage13 drives all of them. | Phase 1 |
| Golden-master harness | **Partially exists** | stage14's reducer goldens (`test/fixtures/reducer-goldens/cases.json`) are true reviewable golden masters for state/effects. Renderer-side golden masters remain partial: Stage 8 asserts substrings, Stage 10 asserts geometry; no per-node semantic DOM projections or reasoned bless workflow yet. | Phase 1 |
| Round-trip property tests | **Exists** | stage13-roundtrip proves all 20 corpus fixtures are normalized fixed points, export-idempotent, and collision-safe through the filesystem projection; stage12 keeps the browser example. | Phase 1 |
| Live/frozen parity harness | **Partially exists** | stage15 asserts sanitizer, KaTeX/MathML, and asset parity on both paths under network denial; stages 1/4/6/8 inspect both outputs. A per-content-type semantic equivalence harness is still missing. | Phase 1 |
| Behavioral probes | **Partially exists** | Playwright covers composer, happy-path stream, settings basics, branching, ingestion, portability, and now credential/preference migrations (stage15) and streaming/save timing (stage16). Stream abort/retry, delete/undo during streams, mid-stream switching, focus, keyboard-only, and per-host durable-ask probes land with Phases 3/6. | Phase 1, expanded in Phases 3/6 |
| Budget gauges with tolerances | **Exists** | stage16 + `test/budgets.json` + `test/calibrate-budgets.mjs`: machine-relative ceilings with recorded tolerances for bundle bytes, snapshot bytes/build time, cold open, streaming rAF batch count/duration, and the save window. Layout-cost gauge still open. | Phase 1 |
