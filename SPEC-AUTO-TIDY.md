# Spec: Auto-tidy

A settings-gated mode that folds branches the reader has stopped attending to, so the canvas stays legible without manual housekeeping. Handoff-ready; assumes the repo's house rules (no template literals in frontend code, comments state constraints only, reuse existing seams before adding new ones). Every decision below is settled — do not reopen product questions.

This is the v2 design (2026-08-31), written as if greenfield: the minimal set of moving parts for the correct model. A v1 engine already exists in the tree; §9 says exactly what to keep and what to discard. Where v1 code matches this spec, keep it byte-for-byte — do not churn it.

## 0 · Prime invariant

**Auto-tidy may only put away what the reader has already seen and left behind. It never hides anything unread, unfinished, or in use.** The cost asymmetry is the whole design: a stale branch left open costs a little clutter; a fold the user didn't expect costs trust in the product. Build for precision, not recall — when any signal is ambiguous, do not fold.

Two independent layers, one persisted and one not. Recording the fact that somebody read a node is not a tidying feature and is never gated by the Auto-tidy preference:

- **Safe** — a per-node *seen* ledger persisted in the hole document (§2). The live-host attention tracker records it in every live session, whether Auto-tidy is on or off. It decides whether a branch may *ever* fold and is derived from document state, never from runtime notifications, so it is correct across reloads, origins, and answers that complete while no UI is open.
- **Stale** — session-only warmth clocks (§4). Decide *when* a safe branch folds.

## 1 · Product behavior (normative)

When enabled, the canvas folds branches using the **exact mechanism of ⋯ → Collapse branch** (`setBranchCollapsed` in `src/ui/canvas/fold.js`): the branch collects into an indented chip stack at its top card, positions saved into `collapse_stack` for restore. No new fold machinery.

**Definitions.**

- **Spine** — the last-touched card plus its ancestor chain to the root.
- **Rib** — a child of a spine card that is not itself on the spine (docked notes and `_ephemeral` nodes excluded). Cold branches fold *at their rib* — never deeper, never higher.

**Rules — each must hold:**

1. The spine never folds, including while the user is in another tab, another app, or the reader. Clocks pause whenever the canvas is not the focused, visible surface — time away never counts against a branch.
2. A rib folds only when **both** hold: no node in its subtree still *needs reading* (§2), **and** it has sat off the spine, untouched, for the grace period (default 2 minutes, user-adjustable).
3. Attention has three tiers (§3): **engaging** attention marks a card seen, resets clocks, and moves the spine; **ambient** attention (hover) only defers a due fold — panning the cursor across the map must not re-warm branches; **protective states** (§4) exempt a branch outright.
4. **New content un-reads.** `reduceNodeAnswered` strips the node's `attention` extensions namespace, so a fresh answer — including one that completed while the app was closed, and one produced by retargeting an existing node — is protected until the user actually engages it. There is no runtime "answer arrived" notification into the tidy consumer; the protection is the data itself.
5. The Auto-tidy preference gates folding only. Enabling resets every clock (nothing folds for the first grace period after toggle-on); it never backfills or guess-marks nodes as seen. Disabling stops future folds and unfolds nothing. Disabled means no folds and no visible difference from the feature not existing, while inert reading-state metadata continues to be recorded. **Settled 2026-08-31: backfill-on-enable is explicitly rejected.**
6. Folds are real document state — persisted, visible in shares and frozen snapshots, byte-identical to a manual Collapse branch. Document state never records that a fold was automatic; provenance is session-side only (§5).
7. Warmth is session state, never persisted; the seen ledger is document state, always persisted in live sessions regardless of the preference. On load, clocks start at load time and the restored current card (`transport-status` restores `{mode, node_id}`) defines the spine. The arrival sweep therefore still happens, but its candidate set is only branches the user read in an earlier session and abandoned. **Pre-feature holes carry no seen data, so on first open nothing folds; branches become foldable as the user engages them, including while Auto-tidy is off (settled 2026-08-31: no grandfathering, no migration).**
8. Frozen/read-only: the feature does not exist — neither live module is constructed and the settings section is never registered.
9. Flattening is accepted: folding a rib absorbs any manual sub-stacks deeper inside it, exactly as manual Collapse branch does today (`restoreCollapseStacksFor` → `compactCollapsedBranch`).

## 2 · The seen ledger

One namespace in the node's extensions bag, written through the existing `node_extensions_patch` channel (the pattern in `src/ui/docked-notes.js:212`):

```
extensions.attention = { seen_at: <ms epoch> }
```

**Needs-reading is a pure read-side rule — no creation-time stamping, no migration:**

```
nodeNeedsReading(node) =
  node.status === "answered"
  && node.origin?.kind !== "note"        // user-authored notes and reactions are trivially seen
  && !node.extensions?.attention?.seen_at
```

- **Set** by the always-on live attention tracker (`src/ui/canvas/attention.js`): on the first *engaging* attention a card receives while its node needs reading, post one `node_extensions_patch` with `namespace: "attention"`, `value: { seen_at: systemClock.now() }`. At most one write per node per read/invalidate cycle — never per event. This write never reads or depends on the Auto-tidy preference.
- **Cleared** by the shared reducer only: `reduceNodeAnswered` in `src/core/hole/reduce.js` drops the `attention` namespace from the node's extensions. This is the single invalidation point, authoritative for every host and client.
- Pending nodes are covered by their own exemption (§4); `nodeNeedsReading` deliberately ignores them.
- Docked notes and `_ephemeral` nodes are excluded from rib subtree walks entirely (existing behavior) and must not block a fold.
- Frozen shares include the namespace; it is inert metadata there. Accepted.
- Because the ledger rides the hole document, it survives reloads, the www/apex/pages.dev origin split, and moves between hosts — no localStorage sidecar, no session cache to reconcile.

## 3 · Attention taxonomy

**Engaging** — marks the attended card seen (if it needs reading), resets clocks, moves the spine:

- `pointerdown` or `focusin` on a card (touch scrolling counts via its initiating `pointerdown`).
- **Card-content scroll**: `viewport.js` already classifies wheel events as card-scroll vs canvas-pan (`r.wheelKind` / `r.wheelCard`, with its can-this-element-still-scroll check). When a wheel tick is classified `"card"` *and* the card's scroller consumes it, notify the composed canvas-maintenance facade with that card; the facade routes it to the attention tracker. A wheel that pans the canvas while incidentally over a card counts for nothing — same principle as hover.
- **Text selection**: a `selectionchange` whose anchor resolves into a card marks that card.
- **Reader**: entering the reader on a node marks it seen; exiting the reader re-warms it as spine tip (the existing `modeChanged` seam).
- Expanding a collapsed stack (emergent — the click is a `pointerdown`).

Engagement marks only the attended card itself, never its ancestors.

**Ambient** — defers a due fold, never warms, never marks seen: hover (`mouseover`/`mouseout` tracking), programmatic scroll restoration.

## 4 · Warmth clocks and exemptions

The clock model: per-rib cold-since stamps (`computeRibs` / `retimeRibs` pure helpers), a 5 s sweep while enabled, pause bookkeeping on `visibilitychange` / window blur / non-canvas mode so time away never counts.

A rib is skipped this sweep if any of:

- subtree contains a node that needs reading (§2 — the prime invariant's enforcement point);
- subtree contains a pinned window (`nodePin` truthy anywhere);
- subtree contains `status === "pending"` (ask in flight / answer streaming);
- subtree contains a node whose PDF source is mid-conversion (`source.converting` — see `src/ui/pdf-view.js:28`);
- subtree contains a card whose composer holds an unsent draft (reuse the `hasDraft` seam in `src/ui/composer-state.js`);
- rib itself is already collapsed (the janitor never fights a manual fold);
- subtree contains the currently hovered card.

Sweep-level bails (whole tick skipped): paused (hidden / unfocused / not canvas mode), `frozen`, `r.activePointerGestures.size > 0`, settings sheet open.

## 5 · Live modules and isolation

The live host constructs both modules through the existing capabilities seam and injects one composed `canvasMaintenanceFactory` (`src/ui/hosts/live/index.js`). `initCanvasView` instantiates and disposes the facade, while the frozen host provides no factory and therefore contains neither module.

- **Attention tracker (`src/ui/canvas/attention.js`)**: owns engagement interpretation, hover state, `nodeNeedsReading`, the per-extensions-object one-write-per-cycle throttle, and `attention.seen_at` patches. It always runs in a live session, exposes engagement subscriptions plus current hover state, and never imports preferences or Auto-tidy.
- **Tidy consumer (`src/ui/canvas/auto-tidy.js`)**: owns warmth clocks, pause/resume, grace, exemption walks, folds, FLIP glide, and false-fold provenance. It consumes the injected attention interface for warmth and hover. The preference gates only its fold sweep; it never writes the seen ledger.
- **One-way dependency, enforced**: only `src/ui/hosts/live/index.js` may import either module. The live host passes the attention tracker to the tidy consumer, so dependency remains attention → subscriber notification → tidy, never tidy knowledge inside attention. `test/contracts/ui-bundle-boundaries.test.mjs` enforces both importer lists and frozen-bundle exclusion.
- **Composed facade**: preserves `cardScrolled`, `branchExpanded`, `modeChanged`, and `dispose`. Card scroll is attention-first; branch expansion is tidy-only false-fold telemetry; mode changes fan out to both modules. The guarded `notifyAutoTidyModeChanged` shim remains a no-op when the facade is absent.
- **Pure policy core**: the fold decision is a pure function of (ribs, clocks, node facts, now) returning `[{ id, reason }]`. Table-driven unit tests; "why did this fold?" always answerable.
- Output flows only through `setBranchCollapsed` — the manual path. Motion: FLIP glide (~320 ms, house easing), skipped under `prefers-reduced-motion`, cancelled instantly by a grab — as already built.
- **Session-side provenance**: a Map of ribId → foldedAt for auto-folds. Expanding an auto-folded stack within 10 s of its fold logs `console.debug("auto-tidy: false fold", id, reason)` — the tuning signal that gates any future default-on decision. Never persisted.

## 6 · Preferences (`src/ui/preferences.js`)

- Key `"rh-auto-tidy"`: `"on"` or absent. **Default off** (opt-in mode).
- Key `"rh-auto-tidy-grace"`: integer seconds as string. **Default 120.** Clamp 5–900 on read/write; never snap stored values to the ladder (e2e tests inject tiny values).
- Exports: `autoTidyEnabled()`, `setAutoTidyEnabled(v)`, `autoTidyGraceSeconds()`, `setAutoTidyGraceSeconds(v)`, `AUTO_TIDY_GRACE_DEFAULT = 120`, `AUTO_TIDY_GRACE_STOPS = [30, 60, 120, 300, 600]`.
- Setters cache and `notify("auto-tidy")`; reads go through `readStored`.

## 7 · Settings UI

"Canvas" nav section (`order: 3`, module `src/ui/canvas-settings.js`), registered only from the live composition so the frozen sheet never has it. Row 1: **Auto-tidy** switch, sub "Folds branches you've moved on from. Your current trail stays open." Row 2: **Fold after** stepper walking the stops (30 s → 10 min, Reset at off-default, disabled-not-hidden while the mode is off, `settings-sheet-row-disabled` dimming). Existing row/switch/stepper grammar, no new control CSS.

## 8 · Tests

**Unit** (`test/unit/auto-tidy.test.mjs`): existing `computeRibs` / `retimeRibs` / preference / formatter cases stand. Add:
- Pure fold decision: needs-reading anywhere in the subtree blocks; each exemption produces no entry; reasons well-formed.
- `nodeNeedsReading`: answered+unseen blocks, note origins never block, `seen_at` clears it.
- Reducer: `node_answered` strips `extensions.attention`; a `node_extensions_patch` sets it.

**E2E** (existing Playwright harness, seeded `rh-auto-tidy = "on"`, `rh-auto-tidy-grace = "5"`, throwaway `RABBITHOLE_DIR`):
1. Engage branch A, work in branch B past the grace → A folds into a standard collapse stack while B and the spine stay open.
2. An answered-but-never-engaged branch does **not** fold, no matter how long past grace.
3. Reload: a previously-engaged-and-abandoned branch folds after one grace; a never-engaged sibling stays open (seen persists).
4. Wheel-scrolling a card's content counts as engagement; wheel-panning the canvas over a card does not.
5. A new answer arriving on a previously-seen branch protects it again until re-engaged.
6. Pinned inside a branch → never folds; hover at due time defers until mouseout; toggle off → nothing folds, but engagement still records `seen_at`.
7. A card with an unsent composer draft never folds.
8. Settings: Canvas tab present between Appearance and Quick questions; switch and stepper round-trip; row 2 disabled while off.
9. Frozen snapshot: no Canvas tab and neither attention nor tidy module.
10. Enable-mid-session: engage branches while Auto-tidy is off, verify their seen ledger is written and no folds occur, enable, verify a fresh full grace period, then verify the previously-read cold branch folds. No enable-time seen backfill is permitted.

`npm test` stays hermetic.

## 9 · Disposition of the existing v1 code

Keep (matches this spec — do not churn):
- Tidy skeleton in `src/ui/canvas/auto-tidy.js`: `computeRibs`, `retimeRibs`, pause bookkeeping, sweep loop, FLIP glide with reduced-motion and grab-to-cancel, enable/disable lifecycle.
- Capabilities wiring (`canvasMaintenanceFactory` in `src/ui/hosts/live/index.js`, construction/disposal in `src/ui/canvas/shared.js`), the four-method facade, and `notifyAutoTidyModeChanged`.
- `src/ui/canvas-settings.js`, the preference keys/exports, the settings section registration, and their tests.

Discard (replaced by document state):
- `contentArrived` on the engine, `notifyAutoTidyContentArrived`, and its call in `src/ui/transport-status.js` — rule 4 makes the runtime notification obsolete.

Add:
- Reducer invalidation in `reduceNodeAnswered`; `nodeNeedsReading` fact + needs-reading exemption in the sweep walk; the always-on attention tracker and engagement-time `seen_at` patch; wheel-card and `selectionchange` and reader-entry engagement; tracker subscription and hover state consumed by tidy; `source.converting` and `hasDraft` exemptions; pure fold-decision extraction with reasons; session provenance + false-fold debug line; two-module `ui-bundle-boundaries` entries; the new tests in §8.

## 10 · Acceptance checklist

- [ ] Nothing ever folds that the user has not engaged at least once since its content last changed — including old holes on first open, unread answers past any grace, and answers that completed while the app was closed.
- [ ] Spine (last-touched lineage) can never fold, in any focus/tab state.
- [ ] Seen survives reload and origin changes (rides the hole document); warmth does not.
- [ ] Cold, fully-read ribs fold at their top card into the standard collapse stack after the grace period; expanding restores saved positions.
- [ ] Pinned, pending/streaming, converting, drafted, already-collapsed, and hovered branches never fold.
- [ ] Card-content scroll, text selection, and reader entry all count as engagement; hover and canvas-panning do not.
- [ ] The live seen ledger records engaging attention whether Auto-tidy is on or off; no preference read exists in the attention tracker.
- [ ] Enabling resets clocks without backfilling seen state; disabling stops folding without unfolding; disabled = no folds and no visible difference, with only inert reading-state metadata still recorded.
- [ ] Folds persist and appear in shares/snapshots exactly like manual folds; no persisted auto/manual distinction.
- [ ] No runtime answer-arrival notification exists; protection of fresh answers is purely reducer-maintained document state.
- [ ] False-fold signal: expanding an auto-fold within 10 s logs a debug line.
- [ ] Settings: "Canvas" section (order 3), Auto-tidy switch (default off), "Fold after" stepper.
- [ ] Frozen builds contain neither attention nor tidy modules, nor the settings section.
- [ ] Folds glide (FLIP), respect `prefers-reduced-motion`, and yield instantly to a grab.
- [ ] Unit + e2e suites above are green; `npm test` stays hermetic.
