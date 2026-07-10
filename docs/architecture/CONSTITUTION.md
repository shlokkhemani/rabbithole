# The Rabbithole visual constitution

This document is law for surface work in Phases 2–10.

It defines the visual vocabulary, geometry, interaction behavior, and review
standard of Rabbithole. Implementations conform to this document. Existing code
is evidence, not authority, where it conflicts with this document.

## 1. Scope and authority

- One token sheet supplies canvas chrome, web chrome, light theme, dark theme,
  and frozen snapshots.
- Chrome consumes named tokens. Per-screen magic design values are forbidden.
- Structural literals remain legal: `0`, `1px`, `100%`, intrinsic dimensions,
  and component-local optical corrections.
- Document-rhythm `em` values form a named document subsystem. They are not
  chrome spacing tokens. They must continue to respond to document scaling.
- Vendored KaTeX and highlight.js styles are outside this constitution.
- Visible convergence is intentional. A blessed visual change is not a
  regression when it brings the product into compliance.
- Every migrated surface must satisfy the experience standard: real-browser
  visual and interaction review, keyboard and screen-reader verification,
  perceived-latency review, and designed error and recovery behavior.

## 2. Token sheet

These names and values are the single source of design values. Compatibility
aliases may exist only during migration. They must resolve to this sheet.

```css
:root {
  /* Type */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  --font-doc: Charter, "Iowan Old Style", "Palatino Linotype", Palatino,
    Georgia, "Times New Roman", serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;

  --text-xs: 10px;
  --text-sm: 11px;
  --text-ui: 12px;
  --text-body: 13px;
  --text-base: 14px;
  --text-title: 17px;

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;

  --leading-tight: 1.2;
  --leading-ui: 1.4;
  --leading-body: 1.55;
  --leading-doc: 1.72;

  --doc-size-canvas: 14px;
  --doc-size-reader: 17px;
  --doc-scale-min: .7;
  --doc-scale-max: 2.4;

  /* Spacing */
  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 10px;
  --space-6: 12px;
  --space-7: 14px;
  --space-8: 16px;
  --space-9: 20px;
  --space-10: 24px;
  --space-11: 28px;
  --space-12: 32px;
  --space-page-x: 48px;

  /* Controls */
  --control-h-xs: 24px;
  --control-h-sm: 28px;
  --control-h-md: 36px;
  --control-h-lg: 44px;
  --control-icon: 16px;
  --control-pad-x: 10px;
  --control-pad-x-compact: 8px;
  --control-gap: 6px;

  /* Shape */
  --radius-inline: 4px;
  --radius-control: 6px;
  --radius-control-lg: 8px;
  --radius-card: 10px;
  --radius-popover: 12px;
  --radius-conversation: 16px;
  --radius-pill: 999px;

  /* Borders and focus */
  --border-default: 1px solid var(--color-border);
  --border-strong: 1px solid var(--color-border-strong);
  --focus-ring: 2px solid var(--color-accent);
  --focus-offset: 2px;
  --focus-field-shadow:
    0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent);

  /* Layout */
  --reader-column: 680px;
  --reader-sidebar: 300px;
  --rail-width: 224px;
  --surface-width-menu: 240px;
  --surface-width-panel: 340px;
  --surface-width-selection: 372px;
  --surface-edge: 14px;
  --surface-gap: 14px;
  --breakpoint-compact: 760px;

  /* Surface metrics */
  --panel-padding-block: 12px;
  --panel-padding-inline: 8px;
  --row-padding-block: 8px;
  --share-item-padding-block: 8px;
  --share-item-padding-inline: 10px;

  /* Motion */
  --duration-instant: 70ms;
  --duration-fast: 120ms;
  --duration-enter: 160ms;
  --duration-slow: 340ms;
  --ease-standard: ease;
  --ease-out: cubic-bezier(.23, 1, .32, 1);
  --ease-spring: cubic-bezier(.3, 1.4, .45, 1);
  --transition-color:
    color var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard);
  --transition-surface:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);

  /* Elevation */
  --shadow-card: 0 4px 18px rgba(28, 25, 18, .08);
  --shadow-popover:
    0 1px 2px rgba(0, 0, 0, .08),
    0 16px 40px -16px rgba(0, 0, 0, .4);
  --shadow-modal: 0 20px 70px rgba(0, 0, 0, .24);

  /* Anchored surface */
  --surface-popover-bg:
    color-mix(in srgb, var(--color-chrome) 88%, transparent);
  --surface-popover-border: var(--border-default);
  --surface-popover-radius: var(--radius-popover);
  --surface-popover-blur: blur(16px) saturate(1.3);
  --surface-popover-shadow: var(--shadow-popover);

  /* Layers: ordering is normative. */
  --layer-reader: 5;
  --layer-feedback: 40;
  --layer-blank: 42;
  --layer-rail: 48;
  --layer-toolbar: 50;
  --layer-selection: 80;
  --layer-dialog: 90;
  --layer-banner: 95;
  --layer-settings: 100;
  --layer-popover: 110;
  --layer-palette: 120;
  --layer-toast: 150;
  --layer-lightbox: 220;

  /* Document rhythm: a separate, scalable subsystem. */
  --doc-heading-1: 1.45em;
  --doc-heading-2: 1.22em;
  --doc-heading-3: 1.05em;
  --doc-heading-minor: .82em;
  --doc-code-size: .82em;
  --doc-block-code-size: .8em;
  --doc-paragraph-gap: .85em;
  --doc-list-indent: 1.35em;
  --doc-block-radius: var(--radius-control-lg);
}

html[data-theme="light"] {
  --color-bg: #f5f3ee;
  --color-grid: #e5e2da;
  --color-text: #3b3833;
  --color-text-strong: #191713;
  --color-text-muted: #7c776d;
  --color-text-faint: #a9a498;
  --color-border: #e4e1d8;
  --color-border-strong: #b9b4a8;
  --color-document: #fdfcfa;
  --color-document-head: #f7f5f0;
  --color-chrome: #faf9f5;
  --color-code: #f1eee7;
  --color-accent: #3b5bcc;
  --color-on-accent: #fff;
  --color-edge: #cdc9be;
  --color-hover: rgba(59, 91, 204, .10);
  --color-selection: rgba(59, 91, 204, .22);
  --color-warning: #a3690e;
  --color-success: #268c60;
  --color-skeleton: rgba(59, 55, 45, .08);
  --color-scrim: rgba(245, 243, 238, .62);
}

html[data-theme="dark"] {
  --color-bg: #1a1918;
  --color-grid: #262422;
  --color-text: #cfccc4;
  --color-text-strong: #efece5;
  --color-text-muted: #94908a;
  --color-text-faint: #6d6963;
  --color-border: #2e2c29;
  --color-border-strong: #4c4945;
  --color-document: #201f1d;
  --color-document-head: #262523;
  --color-chrome: #1e1d1b;
  --color-code: #151412;
  --color-accent: #8faaf0;
  --color-on-accent: #12141c;
  --color-edge: #3d3b37;
  --color-hover: rgba(143, 170, 240, .16);
  --color-selection: rgba(143, 170, 240, .30);
  --color-warning: #d9a866;
  --color-success: #5fbd8d;
  --color-skeleton: rgba(255, 255, 255, .06);
  --color-scrim: rgba(26, 25, 24, .62);
  --shadow-card: 0 6px 24px rgba(0, 0, 0, .45);
  --shadow-modal: 0 20px 70px rgba(0, 0, 0, .48);
}

@media (max-width: 760px) {
  :root {
    --surface-edge: 8px;
    --surface-gap: 8px;
    --space-page-x: 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-instant: 0ms;
    --duration-fast: 0ms;
    --duration-enter: 0ms;
    --duration-slow: 0ms;
  }
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

## 4. Normative behavior table

Status states implementation truth. “Current parity” is already the required
behavior. “Spec ahead of code” is binding before its named implementation phase.

| Area | Normative behavior | Status | Code evidence |
|---|---|---|---|
| Blank app | Resolve explicit hash, then last-opened document, then newest stored document; otherwise open the composer. Escape on a first-use blank canvas reveals the persistent “New Rabbithole” action. | current parity | `src/web/app.js:52`, `src/web/app.js:140`, `src/web/app.js:313`, `src/web/app.js:621` |
| First document | Preserve all three entry paths: ask, file, URL. File launches directly; ask and URL enter their forms. Preserve keyboard focus semantics. | current parity | `src/web/app.js:83`, `src/web/app.js:328` |
| Rail | The rail is an overlay and always starts closed. Open state is never persisted. This is the designed calm default, not a stub. Toolbar and unmodified `S` toggle it; Escape closes it while active; `aria-expanded` tracks state. | current parity | `src/web/app.js:157`, `src/web/app.js:202`, `src/web/app.js:639`, `src/web/app.js:753`, `src/web/app.js:770` |
| Settings placement | Place settings relative to its trigger through the single measure-then-clamp anchoring engine. Consume the shared edge and gap tokens; reposition after open and on resize. | spec ahead of code (Phase 3) | `src/web/app.js:157`, `src/web/app.js:733`, `src/web/app.js:782` |
| Settings semantics | Settings is an anchored non-modal popover. Outside click and Escape close the top layer; nested surfaces close before their parent; closing restores focus to the invoking trigger. Settings continue to apply live. | spec ahead of code (Phase 3) | `src/web/app.js:125`, `src/web/app.js:774`, `src/web/styles.css:615` |
| Streaming follow | Preserve position when the user has scrolled away. Follow the streaming tail while within a small threshold of it. Scroll, pointer, or key input disengages following. The activity chip re-engages and jumps to the active tail. | spec ahead of code (Phase 6) | `src/ui/transport-status.js:151`, `src/ui/transport-status.js:176`, `src/ui/core.js:318` |
| Selection bar | Preserve single-answered-document validation, selection highlight, Enter submit, Escape close, empty-input number shortcuts, and recovery copy. Position it through the common anchoring engine. Add an explicit keyboard-only invocation path. | spec ahead of code (Phases 3/4) | `src/ui/ask-followups.js:71`, `src/ui/ask-followups.js:102`, `src/ui/ask-followups.js:130`, `src/ui/ask-followups.js:150` |
| Toolbar groups | Order groups by task: navigation, view, layout, sharing/preferences, activity. Hide unavailable groups. A separator dies with its group. | current parity | `src/core/html/shell.js:8`, `src/core/html/shell.js:34`, `src/web/styles.css:28` |

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

## 6. Enforcement

- New chrome values must resolve to this sheet or qualify as documented
  structural or optical literals.
- Light and dark modes use the same semantic token names.
- Frozen output remains self-contained. Tokens introduce no external asset,
  stylesheet, preprocessing, or runtime fetch.
- Behavior changes require a deliberate spec amendment or a blessed convergence
  diff. Accidental current-code parity has no standing against this document.
- Surface completion requires browser review, keyboard and screen-reader review,
  perceived-latency review, and designed failure recovery.
- Phases 3–10 may extend this constitution only by naming a new semantic role.
  They may not reopen settled values through component-local invention.
