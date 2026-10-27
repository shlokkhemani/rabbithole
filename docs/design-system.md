# Rabbithole design system

This document defines the visual vocabulary, geometry, interaction behavior,
accessibility requirements, and review standard for Rabbithole surfaces. It is
the source of truth for product chrome across the live canvas, web app, themes,
and frozen snapshots.

## 1. Scope and authority

- One token sheet supplies canvas chrome, web chrome, light and dark themes,
  and frozen snapshots.
- CSS files are real CSS, never templates—`${` is forbidden.
- Chrome consumes named tokens. Per-screen magic design values are forbidden.
- Structural literals remain legal: `0`, `1px`, `100%`, intrinsic dimensions,
  and component-local optical corrections.
- Document-rhythm `em` values form a named document subsystem. They are not
  chrome spacing tokens. They must continue to respond to document scaling.
- Vendored KaTeX and highlight.js styles are outside this design system.
- Every surface must satisfy the experience standard: real-browser visual and
  interaction review, keyboard and screen-reader verification,
  perceived-latency review, and designed error and recovery behavior.

## 2. Token sheet

This section is generated from `src/design/tokens.css`. Edit the stylesheet, then run `npm run generate:design-doc`.

```css
:root {
  /* Type */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-doc: Charter, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --text-xxs: 9px; --text-xxs-plus: 9.5px; --text-xs: 10px; --text-xs-plus: 10.5px;
  --text-sm: 11px; --text-sm-plus: 11.5px; --text-ui: 12px; --text-ui-plus: 12.5px;
  --text-body: 13px; --text-base: 14px; --text-lg: 16px; --text-title: 17px;
  --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600; --weight-strong: 650; --weight-bold: 700;
  --leading-ui: 1.4; --leading-body: 1.55; --leading-doc: 1.72;

  /* Spacing */
  --space-1: 2px; --space-2: 4px; --space-3: 6px; --space-4: 8px; --space-5: 10px; --space-6: 12px;
  --space-7: 14px; --space-8: 16px; --space-9: 20px; --space-10: 24px; --space-11: 28px;

  /* Controls */
  --control-h-xs: 24px; --control-h-sm: 28px; --control-h-md: 36px; --control-h-lg: 44px; --taskbar-pill-pad-block: 7px;
  --control-pad-x-compact: 8px; --control-gap: 6px;

  /* Shape */
  --radius-inline: 4px; --radius-control: 6px; --radius-control-lg: 8px; --radius-card: 10px;
  --radius-popover: 12px; --radius-pill: 999px;

  /* Borders and focus */
  --border-default: 1px solid var(--border);
  --focus-ring: 2px solid var(--accent);
  --focus-offset: 2px;
  --focus-field-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);

  /* Layout */
  --reader-column: 800px; --rail-width: 224px;
  --surface-width-panel: 340px;
  --surface-edge: 14px; --surface-gap: 14px;

  /* Surface metrics */
  --panel-padding-block: 12px; --panel-padding-inline: 8px; --row-padding-block: 8px;
  --share-item-padding-block: 8px; --share-item-padding-inline: 10px;

  /* Motion */
  /* Transitions: one scale. Loops: each named for the motion it paces. */
  --duration-zero: 0ms; --duration-instant: 70ms; --duration-fast: 120ms; --duration-enter: 160ms;
  --duration-move: 220ms; --duration-slow: 340ms;
  --duration-spin: 800ms; --duration-sweep: 1100ms; --duration-breathe: 1150ms; --duration-shimmer: 1350ms; --duration-hop: 1450ms;
  --ease-standard: ease; --ease-out: cubic-bezier(.23, 1, .32, 1); --ease-spring: cubic-bezier(.3, 1.4, .45, 1);
  --transition-color: color var(--duration-fast) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);

  /* Elevation */
  --shadow-card: 0 6px 24px rgba(0, 0, 0, .45);
  --shadow-popover: 0 1px 2px rgba(0, 0, 0, .08), 0 16px 40px -16px rgba(0, 0, 0, .4);
  /* Dark modal shadows must hug the edge: a wide black bloom has nothing
     darker to fade into, so on a dark scrim it reads as a smudged second
     rectangle, not depth. The negative spread tucks the penumbra under the
     sheet; the border and surface contrast do the rest. */
  --shadow-modal: 0 16px 40px -12px rgba(0, 0, 0, .55);

  /* Anchored surface */
  --surface-popover-bg: color-mix(in srgb, var(--bar-bg) 96%, transparent);
  --surface-popover-border: var(--border-default); --surface-popover-radius: var(--radius-popover);
  --surface-popover-blur: blur(16px) saturate(1.3); --surface-popover-shadow: var(--shadow-popover);

  /* Layers */
  --layer-local-base: 1; --layer-local-mid: 2; --layer-local-high: 3; --layer-local-top: 4; --layer-local-toolbar: 6;
  --layer-reader: 5; --layer-pinned: 30; --layer-feedback: 40; --layer-blank: 42; --layer-rail: 48; --layer-toolbar: 50;
  --layer-selection: 80; --layer-dialog: 90; --layer-settings: 100;
  --layer-popover: 110; --layer-palette: 120; --layer-toast: 150; --layer-lightbox: 220;

  /* Document rhythm */
  --doc-heading-1: 1.45em; --doc-heading-2: 1.22em; --doc-heading-3: 1.05em;
  --doc-size-mermaid: .85em; --doc-size-small: .86em; --doc-size-table-head: .92em; --doc-size-compact: .95em;
  --doc-code-size: .82em; --doc-block-code-size: .8em; --doc-size-script: .75em;

  /* Dark is the no-attribute default. */
  --bg: #1a1918; --grid: #262422; --fg: #cfccc4; --fg-bold: #efece5;
  --fg-dim: #94908a; --fg-faint: #6d6963; --border: #2e2c29; --border-focus: #4c4945;
  --card-bg: #201f1d; --card-head: #262523; --bar-bg: #1e1d1b; --code-bg: #151412;
  --accent: #8faaf0; --accent-contrast: #12141c; --edge: #3d3b37;
  --hl: rgba(143, 170, 240, .16); --hl-strong: rgba(143, 170, 240, .30);
  /* Notes are pencil, not ink: the accent belongs to the agent (branches and
     asks), so the human's own marginalia is neutral graphite. All three are
     derived from --fg/--bg and therefore re-resolve under every theme block
     below — those blocks restate the palette, never these, so no note colour
     can drift out of step with the text it sits under. */
  --note-ink: color-mix(in srgb, var(--fg) 70%, var(--bg));
  --note-hl: color-mix(in srgb, var(--fg) 8%, transparent);
  --note-hl-strong: color-mix(in srgb, var(--fg) 15%, transparent);
  --note-card-bg: color-mix(in srgb, var(--note-ink) 6%, var(--card-bg));
  --note-card-head: color-mix(in srgb, var(--note-ink) 14%, var(--card-head));
  --note-card-border: color-mix(in srgb, var(--note-ink) 32%, var(--border));
  --warn: #d9a866; --success: #5fbd8d; --sk-base: rgba(255, 255, 255, .06);
  --scrim: rgba(26, 25, 24, .62);
  --color-black: #000; --color-white: #fff; --color-transparent: rgba(0, 0, 0, 0);
  --image-matte: #f4f4f1; --image-matte-ink: #191713;
  --backdrop-dark: rgba(0, 0, 0, .82); --shadow-alpha-08: rgba(0, 0, 0, .08);
  --shadow-alpha-12: rgba(0, 0, 0, .12); --shadow-alpha-16: rgba(0, 0, 0, .16);
  --shadow-alpha-28: rgba(0, 0, 0, .28); --shadow-alpha-30: rgba(0, 0, 0, .30);
  --shadow-alpha-40: rgba(0, 0, 0, .40); --shadow-alpha-45: rgba(0, 0, 0, .45);
  --shadow-alpha-18: rgba(0, 0, 0, .18); --success-strong: #2f9e44; --danger: #e03131;
  --shadow: var(--shadow-card);
  --popover-bg: var(--surface-popover-bg); --popover-blur: var(--surface-popover-blur);
  --popover-shadow: var(--surface-popover-shadow); --popover-speed: var(--duration-fast); --popover-ease: var(--ease-out);
}

html[data-theme="dark"] {
  --hljs-fg: #c9d1d9; --hljs-keyword: #ff7b72; --hljs-entity: #d2a8ff; --hljs-constant: #79c0ff;
  --hljs-string: #a5d6ff; --hljs-variable: #ffa657; --hljs-comment: #8b949e; --hljs-tag: #7ee787;
  --hljs-section: #1f6feb; --hljs-bullet: #f2cc60; --hljs-addition: #aff5b4; --hljs-addition-bg: #033a16;
  --hljs-deletion: #ffdcd7; --hljs-deletion-bg: #67060c;
}

html[data-theme="light"] {
  --hljs-fg: #24292e; --hljs-keyword: #d73a49; --hljs-entity: #6f42c1; --hljs-constant: #005cc5;
  --hljs-string: #032f62; --hljs-variable: #e36209; --hljs-comment: #6a737d; --hljs-tag: #22863a;
  --hljs-section: #005cc5; --hljs-bullet: #735c0f; --hljs-addition: #22863a; --hljs-addition-bg: #f0fff4;
  --hljs-deletion: #b31d28; --hljs-deletion-bg: #ffeef0;
}

html[data-theme="light"] {
  --bg: #f5f3ee; --grid: #e5e2da; --fg: #3b3833; --fg-bold: #191713;
  --fg-dim: #7c776d; --fg-faint: #a9a498; --border: #e4e1d8; --border-focus: #b9b4a8;
  --card-bg: #fdfcfa; --card-head: #f7f5f0; --bar-bg: #faf9f5; --code-bg: #f1eee7;
  --accent: #3b5bcc; --accent-contrast: #fff; --edge: #cdc9be;
  --hl: rgba(59, 91, 204, .10); --hl-strong: rgba(59, 91, 204, .22);
  --warn: #a3690e; --success: #268c60; --sk-base: rgba(59, 55, 45, .08);
  --scrim: rgba(245, 243, 238, .62);
  --shadow-card: 0 4px 18px rgba(28, 25, 18, .08); --shadow-modal: 0 20px 70px rgba(0, 0, 0, .24);
}

html[data-theme="dark"] {
  --bg: #1a1918; --grid: #262422; --fg: #cfccc4; --fg-bold: #efece5;
  --fg-dim: #94908a; --fg-faint: #6d6963; --border: #2e2c29; --border-focus: #4c4945;
  --card-bg: #201f1d; --card-head: #262523; --bar-bg: #1e1d1b; --code-bg: #151412;
  --accent: #8faaf0; --accent-contrast: #12141c; --edge: #3d3b37;
  --hl: rgba(143, 170, 240, .16); --hl-strong: rgba(143, 170, 240, .30);
  --warn: #d9a866; --success: #5fbd8d; --sk-base: rgba(255, 255, 255, .06);
  --scrim: rgba(26, 25, 24, .62);
  --shadow-card: 0 6px 24px rgba(0, 0, 0, .45); --shadow-modal: 0 16px 40px -12px rgba(0, 0, 0, .55);
}

@media (max-width: 760px) {
  :root { --surface-edge: 8px; --surface-gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  :root { --duration-instant: 0ms; --duration-fast: 0ms; --duration-enter: 0ms; --duration-move: 0ms; --duration-slow: 0ms; }
}
```

### 2.1 Required interpretations

- Base UI is `14px/1.55`.
- The label ladder is `10/11/12/13/14/17px`.
- Design weights are `500/600/700`. Weight `400` remains the base text weight,
  not a design-emphasis tier.
- Icon controls are `28px` for actions and `24px` for compact contexts.
- Control tiers are `28/36/44px`. Every control declares one tier.
- Radii are `6px` compact, `8px` standard, `10px` card, `12px` anchored,
  and `16px` conversational.
- Hover color transitions are `120ms ease`. Standard entrances are `120ms`;
  large or modal entrances are `160ms`.
- The keyboard focus ring is `2px` accent with `2px` offset. The field halo is
  `3px` at `14%` accent.
- Elevation has exactly three semantic levels: card, popover, modal.
- Anchored edge and gap are `14px` desktop and `8px` compact.
- Rail width is `224px`; panel padding is `12px 8px`; row block padding is
  `8px`; share-item padding is `8px 10px`.
- Layer names and their current ordering are normative.
- Success is a theme role named `--color-success`.

## 3. Geometry law

### 3.1 Controls

- Controls in the same tier have the same used height.
- Content, border, and padding fit inside the declared height.
- Icon-only action controls use `28px`. Compact icon controls use `24px`.
- Hover and active states never move perceived geometry. Feedback uses color,
  border, opacity, or tint only.
- A circular send button may use a scale transform for active feedback. It is
  the sole exception. The transform must not affect layout.

### 3.2 Focus

- A keyboard focus ring appears only under `:focus-visible`.
- Pointer focus must not summon a keyboard ring.
- `:focus-within` may emphasize a field or composite container.
- Container emphasis must not impersonate the keyboard ring. It may use the
  field halo, border color, or surface tint.
- Keyboard focus remains visible through every open, close, and nested-surface
  transition. Closing a transient surface restores focus to its trigger.

### 3.3 Anchored surfaces

- One anchoring engine positions every anchored transient surface.
- Every anchored surface consumes `--surface-edge` and `--surface-gap`.
- The engine measures the trigger, the rendered surface, and the viewport,
  then flips and clamps at every edge.
- Assumed-size guessing is forbidden. Hard-coded proxy bounds are forbidden.
- Repositioning follows opening, resize, and any content change that alters the
  measured surface.
- Trigger-relative placement is the default. A different anchor requires a
  named product behavior, not local positioning arithmetic.

## 4. Product behavior

These interaction rules apply wherever the corresponding surface is present.

### 4.1 App entry

- Resolve an explicit hash first, then the last-opened document, then the newest
  stored document. Show the persistent blank-canvas entry when no document is
  available.
- Require an explicitly completed provider/model setup before enabling “New
  Rabbithole” or accepting a dropped file. An incomplete setup opens the model
  settings surface; it never opens an unusable composer.
- Preserve all three entry paths: ask, file, and URL. File launches directly;
  ask and URL enter their forms.
- Move focus deliberately when the entry surface changes. Do not rely on DOM
  order or browser defaults to choose the next focus target.

### 4.2 Rail and toolbar

- The rail is an overlay and starts closed. Its open state is not persisted.
- The toolbar and unmodified `S` toggle the rail. Escape closes it while active,
  and `aria-expanded` reflects its state.
- Order toolbar groups by task: navigation, view, layout,
  sharing/preferences, activity.
- Hide unavailable groups. A separator is hidden with its group.

### 4.3 Settings and transient surfaces

- Settings is an anchored, non-modal popover positioned relative to its trigger
  by the common measure-then-clamp anchoring engine.
- Settings consumes the shared edge and gap tokens and repositions after opening,
  resizing, or a content-size change.
- Outside click and Escape close the topmost transient surface. Nested surfaces
  close before their parent.
- Closing a transient surface restores focus to the trigger that opened it.
- Settings fields persist as they change. Provider/model readiness remains an
  explicit completion step so a validated key alone cannot start generation.

### 4.4 Streaming follow

- Preserve scroll position when the user has moved away from the streaming tail.
- Follow the tail while the viewport remains within a small threshold of it.
- Scroll, pointer, or keyboard input disengages following.
- The activity control re-engages following and moves to the active tail.

### 4.5 Selection bar

- Accept selections from one answered document at a time and preserve the
  selection highlight while the bar is active.
- Provide an explicit keyboard-only invocation path.
- Enter submits, Escape closes, and number shortcuts work when the input is
  empty.
- Position the bar with the common anchoring engine.
- Failure copy explains what happened and how the user can recover.

## 5. Optical corrections

Component-local optical corrections are legitimate structural literals.

Any value that deviates from a token must carry an inline comment that uses the
word `optical` and names the surface it serves. Example:

```css
/* optical: rail row icon baseline */
transform: translateY(.5px);
```

The correction must be local. It must not create a competing design scale or
be promoted to a global token without a repeated semantic role.

Screenshot review is the arbiter. Grep purity is not. A token-complete surface
that looks misaligned is unfinished; an explicitly documented optical correction
that survives screenshot review is compliant.

## 6. Review and enforcement

- New chrome values must resolve to this sheet or qualify as documented
  structural or optical literals.
- Light and dark modes use the same semantic token names.
- Frozen output remains self-contained. Tokens introduce no external asset,
  stylesheet, preprocessing, or runtime fetch.
- Behavior changes require a deliberate design-system amendment. Existing code
  does not override this document by accident.
- Surface completion requires browser review, keyboard and screen-reader review,
  perceived-latency review, and designed failure recovery.
- Extend this design system only by naming a new semantic role. Do not reopen
  settled values through component-local invention.
