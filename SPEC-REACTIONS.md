# Spec: Selection reactions — 👍 / 👎

Status: ready for implementation. Design locked in the playground iterations of
2026-08-31 (single source of truth for look and feel; this spec encodes it).

## 1. Problem

Half the notes a reader leaves are not notes — they are comprehension signals:
"okay, cool", "got it", "this part lost me". They cost typing, and they hand
the model prose where a signal would do. The fix is one tap: select text,
thumb up or thumb down. The agent sees exactly that — a thumbs up or a thumbs
down on that passage — nothing more.

## 2. Structural principles (normative)

An implementation that violates one of these is wrong even if it looks right.

1. **A reaction IS a note node.** Not a new node type, not a new wire event,
   not a new prompt section. It is an ordinary docked selection note
   (`origin: { kind: "note", selected_text, anchor, branch_type: "selection" }`)
   whose entire markdown is the single glyph `👍` or `👎`. Everything the
   product already does for notes — persistence, hole JSON, agent context,
   exports, frozen snapshots, deletion, undo-on-failed-save — applies with
   zero new plumbing.
2. **The wire changes not at all.** `summarizeNotes` in
   `src/core/prompts/answering-v1.js` already renders
   `- Human: Anchored to "…": 👍`. That line *is* "user reacted: thumbs up".
   Do not add reaction-specific prompt copy, meaning sentences, or
   configuration. There is nothing to configure.
3. **Reaction-ness is presentation, carried in the extensions bag.** The note
   extensions gain a flag: `note: { docked: true, reaction: true }`. Identity
   (what was said, where) lives in markdown + origin as with every note; the
   flag only tells the renderer "wash-only, tooltip removal, no editor". This
   mirrors the existing charter in `src/core/hole/reduce.js` ("Docking is
   presentation and only means anything on a parent").
4. **Selection surface only.** Thumbs appear in the select-text popover
   (`#ask`), never in the follow-up composer, card composers, or the ⋯ menu.
5. **The text never moves.** The mark is the graphite note wash and nothing
   else — no margin ink, no inline glyph, no reflow. Backgrounds paint;
   glyphs stay put.
6. **Row spacing is content-hugging.** Every pill sizes to its own content
   with identical padding; the row's slack lives *between* the four groups
   (three preset words + the thumb pair) via `space-between`. The hover wash
   always hugs exactly what will be pressed. This is the system the composer
   CSS already documents — the thumb pair joins it as a fourth "word".

## 3. Data model & engine

- Creation reuses the note path verbatim: `createDockedNote(parent, glyph,
  { anchor, selectedText, reaction: true })` (`src/ui/docked-notes.js:192`),
  from the same `selectionDraft` fields `submitNote` uses
  (`src/ui/ask-followups.js:591`). `blockAnchor` selections are excluded
  exactly as `submitNote` excludes them; PDF region anchors are supported
  (same `anchor.pdf` passthrough).
- Engine: `src/core/hole/node.js:153–175` currently normalizes the `note`
  extensions namespace down to `{ docked: true }`. Extend it to preserve
  `reaction: true`. `reduce.js` note-origin normalization (lines 205–235)
  is untouched — the origin is a plain note origin.
- Markdown is exactly `"👍"` or `"👎"` — nothing appended. Title falls to the
  reduce default `"Note"`; never surface it (reactions render no card).
- One reaction per tap; no dedupe pass. The tooltip × is the manager. A
  reaction is removed through the existing note-deletion path (same events,
  same teardown as deleting a docked note); `rollbackCreatedNote`
  (`docked-notes.js:213`) covers failed saves for free.

## 4. The row (select-text popover)

Markup: `composerActionsMarkup({ id: "ask-actions" })` in
`src/core/html/shell.js:96` gains, after `.preset-actions`, a static pair —
this is chrome like Note/Ask, not a preset:

```html
<span class="thumb-pair">
  <button class="thumb" data-react="up" title="Thumbs up">👍 <kbd>↑</kbd></button>
  <button class="thumb" data-react="down" title="Thumbs down">👎 <kbd>↓</kbd></button>
</span>
```

Rendered **only** for the selection surface (the `#ask-actions` instance);
follow-up and card composers do not receive it.

CSS (`src/design/canvas/base.css`, the existing `.ask-actions` system):

- Row stays `display: flex; justify-content: space-between; gap: 2px` with
  pills sized to content — unchanged.
- `.thumb-pair { flex: 0 0 auto; display: flex; gap: 1px; }` — the pair is
  one group; its two pills are identical (height 26px, `padding: 0 6px`,
  emoji at `--text-ui` scale with `filter: grayscale(.3)` at rest, none on
  hover). Same hover/active/focus-visible treatment as `.lens`, including
  the inset focus ring and `scale(.96)` press.
- Each thumb wears its shortcut chip exactly as presets wear digits
  (same `kbd` recipe).
- The draft swap extends one rule: `.has-draft .thumb-pair { display: none; }`
  beside the existing `.has-draft .lens` line — thumbs hide with the lenses,
  Note/Ask takes the row.

Presets go four → three on the selection surface: in
`src/core/hole/lens.js`, `DEFAULT_ASK_PRESETS.selection` marks `example`
`removed: true` (the mechanism Settings already uses). Users with stored
`rh-ask-presets-v1` keep their configuration untouched; `Example` remains
restorable in Settings. The follow-up default set is unchanged.

## 5. Behavior

- **Tap a thumb** → create the reaction note, clear the selection, hide the
  popover (`hideAsk()`); the wash appears immediately (see §6). A reaction
  completes the interaction — no confirmation, no toast.
- **Keyboard**: `↑` = up, `↓` = down, firing **only while the popover
  textarea is empty** — the same guard the digit shortcuts use in
  `src/ui/composer-state.js`. With a draft present, arrows do caret work and
  nothing else.
- **Disabled states**: thumbs disable exactly when the Note commit disables
  (closed session; visual/block selections — `ask-followups.js:448–454`).

## 6. The mark

- `paintNoteMarks` (`docked-notes.js:200`) paints reaction anchors with an
  additional class: `hl mark-ready mark-note mark-reaction` (and the
  `rh-pdf-mark` twin). CSS: `mark-reaction` is the graphite note wash
  (`--note-hl`), deepening to `--note-hl-strong` on hover — identical to
  today's note-wash hover. No underline, no border, no margin element.
- **Excluded from every note surface**: no note dot (`renderDockedNotes`
  skips reaction notes), no margin-notes rail entry (`renderMarginNotes` in
  `src/ui/reader.js` skips them), no read/edit dialog, no note→ask
  (`canConvertNote` returns false), no card ever rendered on canvas
  (reactions are docked and stay docked; "place on canvas" is not offered).
- **Tooltip** (the only reaction UI after placement):
  - Content: the glyph and an `×` — nothing else.
  - Anchored where the pointer entered the wash, centered above the exact
    line entered (multi-line anchors pick the line under the pointer).
  - It is a DOM child of the wash overlay so hover never breaks crossing
    into it; an invisible bridge covers the 5px gap and hide gets a ~180ms
    forgiveness delay. Show is immediate.
  - `×` deletes the note. The tooltip disappears **instantly** on removal —
    no fade-out (the playground bug: a lingering `:hover` on the tooltip
    itself must not keep it alive once the reaction is gone).
  - Touch: tapping the wash toggles the tooltip; `×` removes.
- **Frozen snapshots**: washes render; tooltip shows the glyph only, no `×`
  (frozen has no mutation surface). No other frozen changes.

## 7. What does not change

- Wire format, `/events` grammar, MCP payloads, `answering-v1` prompt
  assembly, hole JSON schema (the extensions bag is already open),
  portable/export projections (reactions travel as the notes they are).
- Ordinary notes: dots, dialogs, docking, placement, note→ask — untouched.
  A hand-typed note whose text happens to be "👍" is still an ordinary note;
  only the extensions flag makes a reaction.
- Settings: no new section, no configuration. The only Settings-adjacent
  change is the `example` default flip in §4.
- Follow-up composer and card composers: byte-identical.

## 8. Edge cases

- **Overlapping anchors**: allowed, as overlapping notes are today; each wash
  and tooltip manages its own note. No merging.
- **Reacting twice to the same selection**: creates a second note. Acceptable;
  the × removes each independently. No toggle bookkeeping in v1.
- **Agent-authored notes**: agents never create reactions; the flag is only
  set by the thumb path. `summarizeNotes` attribution keeps saying `Human`.
- **Old snapshots / holes without the flag**: absence of `reaction` renders
  as an ordinary note — graceful by construction.
- **Session closed mid-tap**: same failure path as a note commit
  (`rollbackCreatedNote` + hint).

## 9. Tests

Unit:
- `node.js` normalization preserves `note: { docked, reaction }` and drops
  unknown note-extension keys.
- Selection preset defaults: fresh prefs yield three lenses on the selection
  set, four on follow-up; stored prefs override untouched.

Contracts:
- A reaction note round-trips hole JSON and appears in `context.notes` as
  `- Human: Anchored to "…": 👍` (assert the exact line — this encodes §2.2).
- Snapshot/export projections carry the note node and no reaction-specific
  fields beyond the extensions flag.

E2E (extend `test/e2e/enter-composition.test.mjs` patterns):
- Select text → row shows three presets + thumb pair, spaced by the four-group
  system; typing hides pair and lenses, shows Note/Ask; clearing restores.
- `↑` on empty box places 👍: popover closes, wash appears, no note dot, no
  margin rail entry, text layout metrics unchanged (assert no reflow: compare
  a distant element's rect before/after).
- Hover wash → tooltip at pointer-entry position; click `×` → note deleted,
  wash gone, tooltip gone in the same frame.
- Draft present → `↑`/`↓` move the caret and place nothing.
- Frozen page: wash renders, tooltip has no `×`.

## 10. Acceptance checklist

- [ ] Select → one tap (or ↑/↓) records a reaction; agent context shows the
      anchored glyph line with zero prompt changes.
- [ ] Reaction is a note node with `note: { docked: true, reaction: true }`;
      no new event types, no schema changes.
- [ ] Wash-only mark; no margin ink; no text reflow anywhere.
- [ ] Tooltip = glyph + ×; pointer-entry anchored; removal is instant.
- [ ] Reactions absent from dots, margin rail, dialogs, note→ask, canvas.
- [ ] Selection row: three presets + pair, content-hugging spacing,
      has-draft swap intact; follow-up composer untouched.
- [ ] Frozen renders read-only reactions; web/live behavior identical.
- [ ] All §9 tests green; existing note suites untouched and green.
