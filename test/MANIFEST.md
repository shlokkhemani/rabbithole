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
| visual placeholders carry durable identity through settled/pending render and source extraction | C2 | Defines visible pending behavior and the `data-block-id` renderer contract without changing extracted source. | Rendering: unclosed fence mid-stream |
| durable visual mount identity, duplicate insertion, and duplicate-id fallback | C2 | Requires id-keyed instances to survive unrelated edits/reordering while author-error duplicates safely retain legacy occurrence behavior. | — |
| visual sanitizer policy and leading styles | C2 | Protects the `show` security policy and allowed styling. | Rendering: injection via fences/imported payloads (live path) |
| registered block-id normalization | C2 | Mints deterministic ids only for registered fenced blocks, preserves all other bytes, and is idempotent. | — |
| block descriptor and mount registration contract | C2 | Requires validated descriptors, unique block types, and mounts bound to known descriptors. | — |
| pending block recognition derives from the registry | C2 | Proves registered types receive streaming placeholders while unknown fences remain plain code. | Rendering: unclosed fence mid-stream; unknown fence language |
| mount framework sanitizes adapter HTML before wiring | C2 | Makes sanitizer enforcement a framework property rather than a handler convention. | Rendering: injection via fences/imported payloads (live path) |
| built-in block registration metadata golden | C2 | Pins `show@1` and `check@1` plus their sanitizer modes; Check v1 deliberately accepts plain text only, with no Markdown-in-Check support. | Rendering: per-type security policy |
| Check strict parse and legible rejection golden | C2 | Defines the authored JSON model and field-specific failures for malformed questions, options, answers, and explanations. | Data: malformed JSON |
| Check prose projection golden | C2 | Requires Check content to remain available to text-only consumers as question plus newline-separated options. | — |
| Check escaped mount structure golden | C2 | Pins native option buttons, hidden explanation, Try again affordance, and plain-text escaping before framework sanitization. | Rendering: injection via fences; Chrome: keyboard-only completion |
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
| MCP string input caps | C1 | Protects the public MCP boundary by rejecting oversized title and content fields with field-specific Zod errors. | Data: very large holes (input-boundary subset); Migration/deploy: CLI version skew |
| asset route safety, canonical referenced-only export, and SSE progress | C1 | Spans live routes, canonical inert snapshot extraction with referenced-only assets, and MCP event payloads. | Data: snapshot external format and asset normalization; Rendering: frozen viewing fully offline (structural); Generation: durable streaming wire (happy path) |

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
| live MCP share snapshot download | C2 | Opens the real MCP canvas Share menu, downloads through the product action, and validates the canonical inert portable projection, persisted pending-node policy, stylesheet, derived hydration, and referenced-only binary assets. | Data: snapshot export styling and asset portability; Rendering: frozen viewing fully offline |

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
| partial-to-final streaming accumulation and persist-time block-id minting | C2 | Protects observable streaming completion and requires final canonical markdown to carry durable block identity. | Generation: durable streaming happy path |
| legacy view leaves stored markdown byte-unchanged | C1 | Opening and viewing legacy persisted content must not silently migrate its block syntax. | Migration/deploy: new code, old storage without read-side mutation |
| canonical MCP export, renderer capabilities, and web-import round trip | C1 | Protects the public inert snapshot shape, portable bootstrap, offline math/code/show/asset rendering, and MCP-authored snapshot → web import compatibility. Reclassified from C2 because the route now emits the public portable artifact format rather than a product-only frozen hydration. | Data: snapshot external format and cross-host portability; Rendering: frozen viewing fully offline (structural evidence only) |
| MCP resume refuses a newer schema with exact recovery copy | C1 | Prevents an older MCP host from opening and later truncating a newer document. | Data: future schema version; Migration/deploy: CLI version skew |
| MCP block_state persistence and agent-context exclusion | C1 | Proves the additive browser event persists learner state while rehydration/branch payloads remain lean and snapshot payloads omit the extension bag. | Migration/deploy: additive wire compatibility; Data: snapshot extension stripping |

## `stage9-store-contract.mjs` (filesystem store)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| hole save/load/list/delete and schema stamping | C1 | Defines the filesystem store contract. | — |
| v0.2 fixture migrates, saves, reloads as schema v2 | C1 | Protects persisted legacy migration. | Migration/deploy: new code, old storage/idempotent migrations (filesystem) |
| newer schema load is refused with exact recovery copy | C1 | Pins filesystem/startup refusal before reconstruction can drop fields. | Data: future schema version |
| asset put/get/list/delete | C1 | Defines persisted asset operations. | — |
| staging create/put/adopt | C1 | Defines PDF staging operations. | — |
| bad IDs/names/traversal rejected | C1 | Protects storage trust boundaries. | — |
| shared asset GC and final-reference deletion | C2 | Protects deletion asset semantics. | — |

## `stage9-idb-store-contract.mjs` (IndexedDB store)

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| hole save/load/list/delete and schema stamping | C1 | Defines the browser store contract. | — |
| v0.2 fixture migrates, saves, reloads as schema v2 | C1 | Protects old IndexedDB data under new code. | Migration/deploy: new code, old IndexedDB/idempotent migrations |
| newer schema load is refused with exact recovery copy | C1 | Pins IndexedDB startup refusal before reconstruction can drop fields. | Data: future schema version |
| asset put/get/list/delete | C1 | Defines browser binary-asset operations. | — |
| staging create/put/adopt | C1 | Defines browser PDF staging operations. | — |
| bad IDs/names/traversal rejected | C1 | Protects browser storage trust boundaries. | — |
| shared asset GC and final-reference deletion | C2 | Protects deletion asset semantics. | — |

`support/store-contract.mjs` is an unwired helper, not an independently executed suite; its seven exported cases are the seven rows instantiated for each Stage 9 backend above.

## `stage10-web-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| calm landing, three-path composer, path copy, dismiss-without-create | C2 | Protects first-run navigation and empty state. | — |
| stateful Check live/reload/portable/frozen cycle | C2 | Drives native-keyboard selection through the real UI, persistence and hydration, portable state retention, snapshot stripping, and offline frozen interaction. | Rendering: live/frozen parity; Data: learner progress portability and share exclusion; Chrome: keyboard-only completion |
| blank-state centering and composer initial focus | C2 | Protects visible placement and initial keyboard focus. | Chrome: keyboard-only completion (small opening/closing subset) |
| Dialog composer containment, dismissal, and restoration | C2 | Requires live-content Tab/Shift+Tab wrapping, enforced modal labeling, Escape and backdrop dismissal, and deterministic toolbar/N-trigger focus restoration while first-visit auto-open remains triggerless-safe. | Chrome: keyboard-only completion; focus restoration after transient surfaces; outside-pointer dismissal |
| toolbar Button kit conformance | C2 | Requires every reader/canvas toolbar button to declare `type="button"` and expose a non-empty accessible name. | Chrome: toolbar accessibility |
| Notice timer replacement, hover pause, live regions, and banner dismiss | C2 | Requires one wired-shell Notice contract to replace timers without early hiding, pause timed feedback during interaction, announce politely, and dismiss persistent banners. | Chrome: transient feedback accessibility |
| reader/canvas toolbar keyboard activation and focus-visible rings | C2 | Exercises Enter/Space activation across both modes and requires the constitutional keyboard-only ring on both toolbar families. | Chrome: keyboard-only completion; focus visibility |
| warm re-entry, hash precedence, rail delete fallback, and Undo | C2 | Protects saved-hole navigation, recovery, and actionable-toast restoration. | — |
| first ask key validation and streamed root creation | C2 | Protects BYOK first-run streaming behavior. | Generation: 401/403 (pre-stream validation only); title never arrives (non-sentinel root title path only) |
| rail content/geometry exact values | C2 | Pins the intended post-Phase-2 semantic rail width, panel padding, and symmetric row-padding design. | — |
| keyboard-opened rail holds focus without a container ring; Escape closes only the rail | C2 | Focus policy: the panel takes focus so keys flow into rows, container emphasis must not impersonate the keyboard ring (was a UA `outline: auto` around the whole panel), and Escape must not fall through to the canvas client's open-the-reader shortcut (it did — the rail handler leaked propagation). | Chrome: keyboard-only completion (rail subset) |
| credentials stay isolated from holes/snapshots | C1 | Protects the no-export credential contract. | Data: preference/credential storage (isolation only, not migrations) |
| inert snapshot portable carrier and canonical projection | C1 | Requires exactly one typed/id-addressed inert JSON payload whose document matches the flushed canonical portable export after the documented one-time live view-state substitution and referenced-only asset normalization, including all canonical timestamps, with extraction parity against the shipped extractor; immediate real-UI mutations pin both snapshot and portable flush-before-export, while an immediate view change pins live-view-at-export timing, all without timer waits. | Data: snapshot external format; Rendering: frozen viewing fully offline; Data: export-vs-debounce timing |
| snapshot payload script-breakout escaping and JSON fidelity | C1 | Requires `<`, `>`, `&`, U+2028, and U+2029 to be escaped without changing the value recovered by JSON parsing from inert script text. | Data: snapshot external format; Rendering: script-element breakout defense |
| legacy direct-hydration frozen snapshot boot | C1 | Preserves one-way viewing compatibility for snapshots created before the inert portable carrier; it does not make legacy snapshots importable. | Migration/deploy: new code opening old snapshots |
| web-exported frozen snapshots apply canonical self-contained styles | C2 | Requires exports to embed the shared canvas and self-contained KaTeX stylesheet with structural toolbar styling active after offline hydration, while excluding web-only chrome CSS. | Rendering: frozen viewing fully offline; Data: snapshot export styling |
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
| newer-schema file import shows exact update-to-open refusal | C1 | Pins the recoverable user-visible refusal in the existing ingest-status surface. | Data: future schema version |
| empty-MIME and exact-suffix file classification | C2 | Requires mixed-case HTML, PDF, and Markdown extensions to classify without MIME while preventing `.html.txt` from becoming a snapshot. | Data: malformed/imported input routing |
| markdown import enforces 16 MB pre-read cap | C2 | Requires the real file-input surface to reject oversized text imports with the designed ingest-status error before parsing. | Data: very large holes (input-boundary subset) |

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
| typed store fixture satisfies the port and missing capabilities are rejected | C1 | Couples the compile-time store vocabulary to the runtime capability authority and proves every required method is enforced. | — |
| typed artifact fixtures validate and invalid persisted/portable shapes are rejected | C1 | Couples the persisted and portable declarations to their runtime validators at the trust boundary, including canonical construction and Blob/Uint8Array binary codec parity. | Data: malformed JSON/base64; hand-edited payload types |
| typed generation fixture distinguishes the two-event vocabulary from malformed events | C2 | Exercises both Phase 6 generation variants and rejects wrong fields, wrong value types, and the speculative usage discriminator. | Generation: durable streaming vocabulary; title never arrives |
| typed content fixtures distinguish extension, hydratable-block, and primitive shapes from malformed values | C2 | Couples the settled descriptor/mount vocabulary to its runtime authorities while leaving unbuilt Walk/Play lifecycle names explicitly provisional. | Rendering: content extension and hydration vocabulary |
| typed persisted, legacy, and portable artifacts round-trip with defined normalization | C1 | Proves canonical schema-v2 fixed points, null/v1 backfill stability, and portable envelope preservation through validate/migrate/re-persist. | Data: portable compatibility; `schema_version: null` |
| non-object node extensions are legibly rejected | C1 | Couples the typed JSON-object extension contract to runtime validation. | Data: hand-edited payload types |
| v1 open-modify-save-reopen preserves the schema-v2 extension bag | C1 | Proves the THESEUS forward-safety bridge across migration and an unrelated update. | Data: new-format document modify-save-reopen |
| future format_version is clearly refused | C1 | Protects the public portable-file version boundary and its recoverable refusal. | Data: future `format_version` clear refusal |
| future schema_version is legibly refused | C1 | Ensures old builds refuse unknown persisted schemas instead of silently dropping fields. | Data: new-format document through an old build refuses; future schema version |
| schema_version null backfills, persists, and reloads | C1 | Protects forever-readable legacy files and idempotent migration through the filesystem store. | Data: `schema_version: null` legacy backfill; Migration/deploy: old storage/idempotent migrations |
| malformed JSON, base64, and wrong-type fields reject without crashing | C1 | Exercises portable and schema trust boundaries with representative malformed inputs. | Data: malformed JSON/base64; hand-edited payload types |
| unicode, emoji, and RTL titles survive validate-persist-reload | C1 | Protects lossless international text across validation and filesystem persistence. | Data: unicode/emoji/RTL titles |
| portable and snapshot imports mint durable block ids idempotently | C1 | Requires both public import carriers to persist canonical block identity and preserve it across canonical re-import. | Data: portable and snapshot import compatibility |
| inert snapshot and portable import boundary | C1 | Protects canonical text-only extraction, legacy/duplicate/malformed refusal, uniform file/payload/node/asset caps, encoded-length preflight, hostile-HTML non-execution, credential exclusion, and cleanup-on-failure. | Data: hand-edited snapshot payloads; malformed JSON/base64; import limits; device-secret isolation |
| exact 20 MB asset is accepted and one byte over is rejected | C1 | Pins both sides of the documented per-asset byte boundary using generated data. | Data: 20MB asset boundary |

## `stage13-roundtrip-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| all corpus fixtures are normalized three-projection fixed points and export-idempotent | C1 | Protects portable migration, assets, durable asks, and filesystem persistence across portable → real FsStore → canonical snapshot HTML → web snapshot import → portable cycles for all 20 fixtures. Referenced assets remain byte-exact and unreferenced assets intentionally drop at the snapshot hop. Exports remain anchored to source except for the two deliberately migrated legacy fixtures. | Data: portable compatibility; `schema_version: null`; unicode/emoji/RTL; very wide holes; durable asks per host semantics; referenced-only snapshot assets |
| extension bags survive portable round trips and are stripped from snapshots | C1 | Proves backups carry structurally faithful learner progress while share artifacts omit it and imports normalize the omission to `{}`. | Data: portable compatibility; snapshot personal-state exclusion |
| portable and snapshot import collisions mint a fresh hole_id and preserve content | C1 | Protects collision-safe identity generation without content or asset loss and pins snapshot → import → `.rabbithole` as a canonical fixed point. | Data: import ID collision; portable compatibility |

## `stage14-reducer-conformance.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| canonical hydration-node projection preserves both host wire shapes | C1 | Pins the exact shared browser hydration payload while preserving the web host's intentional root-origin suppression and the MCP host's origin metadata. | Migration/deploy: additive wire compatibility |
| branch_request happy path | C2 | Pending branch construction and URL inheritance are observable document behavior. | — |
| branch_request missing parent throws | C2 | Invalid branch requests must fail rather than create detached nodes. | — |
| branch_request missing node_id throws | C2 | Branch nodes require stable identity. | — |
| node_progress grows then idempotently replays | C2 | Full-markdown replacement and same-text replay define current streaming behavior. | Generation: durable streaming (reducer side) |
| stale same-run node_progress is discarded | C2 | The reducer is the single ordering authority for tagged progress and rejects non-increasing sequence numbers without changing state. | Generation: stale progress after newer progress |
| higher same-run node_progress is accepted | C2 | Increasing sequence numbers advance both markdown and the ephemeral per-node run record. | Generation: stale progress after newer progress |
| new node_progress run id supersedes | C2 | A retry is a new run and supersedes the prior run regardless of its sequence number. | Generation: stale progress after newer progress |
| node_answered clears progress ordering record | C2 | Completion ends the recorded run, so later tagged progress follows the no-record acceptance path. | Generation: stale progress after newer progress |
| delete_node clears progress ordering record | C2 | Removed node identities retain no ephemeral run history if an id is later reused. | Generation: delete-while-streaming; stale progress after newer progress |
| node_answered updates existing pending node | C2 | Completing an existing pending node is core generation behavior. | — |
| node_answered synthesizes unknown node | C2 | Final answers may materialize a node when no pending node exists. | — |
| delete_node subtree collection and effects | C2 | Deletion must remove descendants and return sufficient effect data for consumers. | — |
| delete_node explicit node_ids and effects | C2 | Explicit deletion lists are part of reducer behavior and effect reporting. | — |
| root delete throws | C2 | The starting document is protected from node deletion. | — |
| node_update and nodes_update field application | C2 | Supported presentation fields must normalize consistently while unknown nodes remain untouched. | — |
| view_state normalization | C2 | Persisted navigation state has a normalized shape and bounded camera scale. | — |
| hole_title replaces document title | C2 | Internal title changes must flow through the immutable engine without changing MCP/SSE vocabulary. | — |
| node_origin replaces opaque metadata | C2 | Internal origin changes must flow through the immutable engine without changing MCP/SSE vocabulary. | — |
| malformed known node_progress is a no-op | C2 | Pins the reducer's current coercive/no-validation behavior for malformed trusted-engine input. | — |
| block_state deep merge and tolerant invalid targets | C2 | Preserves unrelated extension data, shallow-merges per-block state, and safely ignores absent ids and unknown nodes without generation ordering guards. | Data: extension-bag preservation; Migration/deploy: additive events |
| unknown event type throws | C2 | Unsupported vocabulary must fail explicitly rather than silently diverge. | — |
| frozen-input reducer immutability | C2 | The reducer must not mutate its input state, node map, event, or node objects; changed nodes receive fresh identity. | — |
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
| credential exclusion from all three projections | C1 | Every current, legacy, removed-provider, and malformed migration fixture proves the device secret and `rh-web-settings` key are absent from portable JSON, snapshot HTML, and the raw persisted hole record. | Data: preference/credential storage through every migration; artifact and store-record credential non-leakage |
| portable-import asset MIME derivation | C1 | Requires portable import to derive the Blob MIME type from the validated asset filename without serializing MIME metadata. | Rendering: frozen viewing fully offline; Data: portable asset migration |

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

## `stage17-packaging-smoke.mjs`

This release-only check runs through `npm run test:packaging`, outside the default suite, and is matrixed across Node 18 and 20 in CI.

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| packed artifact contains executable, metadata, runtime source, and committed bundles | C1 | The npm tarball is the public installation contract; every raw Node/core runtime file and built browser asset required by the executable must ship. | Migration/deploy: publish contents and CLI installation compatibility |
| installed tarball launches and completes MCP initialize | C2 | A clean consumer project must be able to invoke the installed CLI and receive only a valid MCP initialize response on stdout before clean shutdown. | Migration/deploy: `npx` publish-install smoke on Node 18 and 20 |

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

## `stage18-generation-adapters-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| OpenAI-compatible SSE fragmentation and framing | C3 | Deterministically pins the provider adapter's tolerant SSE framing across every byte boundary, multi-event reads, CRLF, and `[DONE]`. | Generation: durable streaming vocabulary (provider ingress) |
| Anthropic Messages SSE fragmentation and framing | C3 | Deterministically pins the fallback adapter's tolerant SSE framing across every byte boundary, multi-event reads, CRLF, and `[DONE]`. | Generation: durable streaming vocabulary (provider ingress) |
| title-sentinel fragmentation and terminal forms | C2 | Preserves branch title extraction and byte-identical visible markdown for every sentinel split offset, start/end placement, absent, malformed, and partial sentinels. | Generation: title never arrives; arbitrary provider chunking |
| provider error normalization | C2 | Preserves the browser-visible abort, provider, and network error vocabulary and retryability. | Generation: real stream abort; rate limits |
| branch GenerationEvent adapter containment | C2 | Requires exactly one title event, no sentinel leakage, and byte-exact text concatenation from fixture streams. | Generation: durable streaming vocabulary; title never arrives |
| authoring GenerationEvent adapters are text-only | C2 | Requires both provider brains' explainer/document surfaces to emit only text events while preserving provider bytes exactly. | Generation: durable streaming vocabulary |
| pure GenerationRun accumulator and DocEvent goldens | C2 | Pins full-text accumulation, monotonic run tags, late/fallback titles, empty completion, deterministic repeat completion, and rejection of non-generation/error input without host lifecycle ownership. | Generation: shared accumulation and transition construction |
| browser branch GenerationRun wiring | C2 | Requires browser branch GenerationEvents to produce the same progress/completion DocEvents as direct GenerationRun consumption. | Generation: shared accumulation and transition construction |
| MCP GenerationIngress normalization | C2 | Pins tail and repeated-full-answer normalization before GenerationEvents, tagged progress through GenerationRun, final title flow, and fresh run identity. | Generation: MCP durable streaming; shared accumulation and transition construction |
| browser branch retry run guard | C2 | Requires each retry to mint a new run id and rejects late progress from its superseded aborted run. | Generation: stale progress after newer progress; real stream abort |
| browser branch empty-stream completion | C2 | Preserves the intentional branch/root asymmetry: an empty branch stream completes with fallback title and empty markdown. | Generation: title never arrives (empty-stream side) |
| browser root GenerationRun wiring and empty rejection | C2 | Requires root explainer GenerationEvents to flow through GenerationRun while preserving rejection of empty and whitespace-only streams. | Generation: empty provider answer; shared accumulation and transition construction |
| document authoring through host lifecycle | C2 | Requires authoring to use host-owned run ids, abort ownership, reducer transitions, and save exactly on completion. | Generation: durable streaming vocabulary; real stream abort |
| retired text-delta seam absence | C2 | Prevents browser generation surfaces from bypassing GenerationRun through the temporary event-to-text helper. | Generation: shared accumulation and transition construction |
| browser lifecycle save flush | C2 | Requires hidden visibility and pagehide to invoke the existing host flush seam, closing the final debounce window without changing save policy. | Generation: browser durable partial markdown on tab close |

## `stage19-journey-verify.mjs`

| Case | Category | Rationale | Scenario-ledger entries covered |
|---|---|---|---|
| modern MCP/web cross-host journey | C1 | Pins one continuous MCP authoring, real selection branch and streamed answer, snapshot download, fresh-profile web import, portable export, filesystem import, and MCP rehydration path with byte-faithful content/assets and credential exclusion. | Cross-host compatibility; snapshot and portable external formats; durable MCP rehydration |
| v0.1 temporal cross-host journey | C1 | Carries the oldest `schema_version:null` fixture through real web snapshot/portable surfaces into MCP resume, requiring one trust-boundary migration to schema v2 and stability thereafter. | Migration/deploy: v0.1-era hole retained through Phase 9; idempotent migration; cross-host compatibility |

## Counts

Current inventory arithmetic: `65 + 167 + 10 + 0 + 0 = 243` total cases.

Phase 9 Slice 1 adds one C1 case (MCP string input caps) and two C2 cases (file classification, markdown pre-read cap): 62 + 1 = 63, 165 + 2 = 167, and 238 + 3 = 241.

Phase 9 Slice 2 adds two C1 cross-host journey cases: 63 + 2 = 65 and 241 + 2 = 243, yielding 65 + 167 + 10 + 1 + 0 = 243.

Phase 9 Slice 3 reclassifies the intended post-Phase-2 rail design from C4 to C2 and closes the known-defect category; the audited inventory remains `65 + 167 + 10 + 0 + 0 = 243`.

Phase 8 Slice 4 adds one C1 case for the additive MCP state wire and six C2 cases for Check registration, parsing, prose projection, escaped mount structure, reducer semantics, and the real live/reload/export/frozen cycle: C1 `61 + 1 = 62`, C2 `159 + 6 = 165`, and total `231 + 7 = 238`, yielding `62 + 165 + 10 + 1 + 0 = 238`.

Phase 8 Slice 1 adds seven C1 cases: MCP resume refusal, filesystem and IndexedDB load refusal, web import refusal, non-object bag validation, the v1 forward-safety cycle, and portable/snapshot bag projection: `52 + 7 = 59` and `218 + 7 = 225`, yielding `59 + 154 + 11 + 1 + 0 = 225`.

Phase 8 Slice 2 adds three C2 cases for the block registry contract, registry-derived pending recognition, and framework-owned mount sanitization: `154 + 3 = 157` and `225 + 3 = 228`, yielding `59 + 157 + 11 + 1 + 0 = 228`.

Phase 8 Slice 3 adds one C2 normalization case and two C1 persistence/import compatibility cases, and reclassifies durable mount identity from C3 to C2: C1 `59 + 2 = 61`, C2 `157 + 1 + 1 = 159`, C3 `11 - 1 = 10`, and total `228 + 3 = 231`, yielding `61 + 159 + 10 + 1 + 0 = 231`.

Counts treat each row above as one case; the shared Stage 9 contract counts once per backend because `npm test` executes it against both. Phase 5 Slice 2 added three C1 rows (`41 + 3 = 44`, `184 + 3 = 187`). Slice 3 added three C2 rows and reclassified the reducer mutation probe from C3 to C2: `129 + 3 + 1 = 133`, `10 - 1 = 9`, and `187 + 3 = 190` total. Slice 4 retires the stale-progress C4 as a C2 and adds four ordering goldens: `133 + 1 + 4 = 138`, `4 - 1 = 3`, and `190 + 4 = 194` total. Slice 5 adds one generation-vocabulary C2 case: `138 + 1 = 139` and `194 + 1 = 195` total. Slice 7 adds one content-vocabulary C2 case: `139 + 1 = 140` and `195 + 1 = 196` total. Slice 8 adds one hydration-wire C1 golden: `44 + 1 = 45` and `196 + 1 = 197` total. Slice 9 adds one packaging C1 case and one installed-launch C2 case: `45 + 1 = 46`, `140 + 1 = 141`, and `197 + 2 = 199` total. Phase 6 Slice 1 adds four C2 adapter/parser/error cases and two C3 SSE framing cases: `141 + 4 = 145`, `9 + 2 = 11`, and `199 + 6 = 205` total. Phase 6 Slice 2 adds two C2 cases: `145 + 2 = 147` and `205 + 2 = 207` total. Phase 6 Slice 3 adds three C2 browser-branch wiring cases: `147 + 3 = 150` and `207 + 3 = 210` total. Phase 6 Slice 4 adds three C2 root/authoring/seam-retirement cases: `150 + 3 = 153` and `210 + 3 = 213` total. Phase 7 Slice 1 reclassifies the portable-import MIME fossil from C4 to C1: `46 + 1 = 47`, `3 - 1 = 2`, and the total remains `214`. Phase 7 Slice 2 adds three C1 snapshot-format cases (canonical inert projection, escaping fidelity, and legacy viewing compatibility): `47 + 3 = 50` and `214 + 3 = 217` total. Phase 7 Slice 3 extends the existing frozen-styles C2 case, so the arithmetic remains `50 + 154 + 11 + 2 + 0 = 217`. Phase 7 Slice 4 retires the hand-edited snapshot C4 as an executable C1 boundary case: `50 + 1 = 51`, `2 - 1 = 1`, and the total remains `217`, yielding `51 + 154 + 11 + 1 + 0 = 217`. The MCP snapshot regression fix adds one C2 live-product download case: `154 + 1 = 155` and `217 + 1 = 218`, yielding `51 + 155 + 11 + 1 + 0 = 218`. Phase 7 Slice 5a reclassifies one legacy frozen-export C2 row as a canonical cross-host artifact C1 row: `51 + 1 = 52`, `155 - 1 = 154`, and the total remains `218`, yielding `52 + 154 + 11 + 1 + 0 = 218`.

| Category | Count |
|---|---:|
| C1 compatibility contract | 65 |
| C2 behavioral product contract | 167 |
| C3 implementation snapshot | 10 |
| C4 known defect | 0 |
| C5 design target | 0 |
| **Total** | **243** |

## Known-defect fossils

- `stage10-web-verify.mjs:421-442` retains settings surface equality and the optical gear offset; `stage10-web-verify.mjs:486-521` retains share surface equality and exact shell/item padding. Anchoring itself is now a C2 engine contract rather than a bespoke-geometry fossil.
- No assertion requires settings `innerHTML` rebuilding or focus-hunting. `stage2-verify.mjs:253-271` does rebuild a synthetic content container via `innerHTML`, but its asserted contract is visual mount identity/cache behavior, not that settings/chrome must rebuild. No current case asserts focus restoration after settings close, so the bespoke focus-hunting debt is unprotected rather than fossilized.

## Retired baseline defects

Both portable-projection baseline defects are retired: stage13 exports asset-bearing corpus fixtures through the real `FsStore` Buffer return, and stage15 requires extension-derived MIME on imported asset Blobs.

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

- Data: genuinely very large holes with a budget (the wide-hole fixture and snapshot gauges only cover reference-sized content).
- Rendering: reduced motion; semantic dark parity.
- Migration/deploy: a real mid-session deploy (new code opening old IndexedDB, with migration rerun/idempotence — stage15 covers localStorage preferences, not the IDB schema during a live session); CLI version skew with an older CLI against additive wire changes; a v0.1-era hole retained through Phase 9.

**Phase 3 — settings vertical slice**

- Chrome: focus restoration on every overlay close; Escape/outside-click ordering with stacked overlays; anchored surfaces at every viewport edge; keyboard-only completion of every manifest flow; settings opened/changed during an active stream; Combobox behavior for slow, failed, and empty catalogs.

**Phase 6 — generation normalization**

- Generation: real stream abort; error mid-stream with browser-partial persistence and MCP-partial dropping/re-ask; stale progress after newer `{id,seq}` progress; empty provider answer; missing title fallback; N concurrent streams; delete while streaming; provider/model switch mid-stream; 401/403 during a stream with prompt-and-retry closure; rate limits; tab close mid-stream bounded by the save budget.

### Part III instruments

| Instrument | Assessment | Evidence / missing work | First needed |
|---|---|---|---|
| Fixture corpus | **Exists** | `test/fixtures/corpus/` holds 20 curated files (math, show, assets, deep lineage, both durable-ask semantics, Unicode/RTL, `schema_version:null`, v0.2 legacy, wide holes) plus the in-test generated 20 MB boundary; stage13 drives all of them. | Phase 1 |
| Golden-master harness | **Partially exists** | stage14's reducer goldens (`test/fixtures/reducer-goldens/cases.json`) are true reviewable golden masters for state/effects. Renderer-side golden masters remain partial: Stage 8 asserts substrings, Stage 10 asserts geometry; no per-node semantic DOM projections or reasoned bless workflow yet. | Phase 1 |
| Round-trip property tests | **Exists** | stage13-roundtrip proves all 20 corpus fixtures are normalized fixed points, export-idempotent, and collision-safe through the filesystem projection; stage12 keeps the browser example. | Phase 1 |
| Live/frozen parity harness | **Partially exists** | stage15 asserts sanitizer, KaTeX/MathML, and asset parity on both paths under network denial; stages 1/4/6/8 inspect both outputs. A per-content-type semantic equivalence harness is still missing. | Phase 1 |
| Behavioral probes | **Partially exists** | Playwright covers composer, happy-path stream, settings basics, branching, ingestion, portability, and now credential/preference migrations (stage15) and streaming/save timing (stage16). Stream abort/retry, delete/undo during streams, mid-stream switching, focus, keyboard-only, and per-host durable-ask probes land with Phases 3/6. | Phase 1, expanded in Phases 3/6 |
| Budget gauges with tolerances | **Exists** | stage16 + `test/budgets.json` + `test/calibrate-budgets.mjs`: machine-relative ceilings with recorded tolerances for bundle bytes, snapshot bytes/build time, cold open, streaming rAF batch count/duration, and the save window. Layout-cost gauge still open. | Phase 1 |
