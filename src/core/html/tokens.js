/*
 * Shared, self-contained design-token payload. Compatibility names are retained
 * for stylesheet stability.
 */
export const DESIGN_TOKENS = `:root {
  /* Type */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-doc: Charter, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --text-xs: 10px; --text-sm: 11px; --text-ui: 12px; --text-body: 13px; --text-base: 14px; --text-title: 17px;
  --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600; --weight-bold: 700;
  --leading-tight: 1.2; --leading-ui: 1.4; --leading-body: 1.55; --leading-doc: 1.72;
  --doc-size-canvas: 14px; --doc-size-reader: 17px; --doc-scale-min: .7; --doc-scale-max: 2.4;

  /* Spacing */
  --space-1: 2px; --space-2: 4px; --space-3: 6px; --space-4: 8px; --space-5: 10px; --space-6: 12px;
  --space-7: 14px; --space-8: 16px; --space-9: 20px; --space-10: 24px; --space-11: 28px; --space-12: 32px;
  --space-page-x: 48px;

  /* Controls */
  --control-h-xs: 24px; --control-h-sm: 28px; --control-h-md: 36px; --control-h-lg: 44px;
  --control-icon: 16px; --control-pad-x: 10px; --control-pad-x-compact: 8px; --control-gap: 6px;

  /* Shape */
  --radius-inline: 4px; --radius-control: 6px; --radius-control-lg: 8px; --radius-card: 10px;
  --radius-popover: 12px; --radius-conversation: 16px; --radius-pill: 999px;

  /* Borders and focus */
  --border-default: 1px solid var(--color-border);
  --border-strong: 1px solid var(--color-border-strong);
  --focus-ring: 2px solid var(--color-accent);
  --focus-offset: 2px;
  --focus-field-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent);

  /* Layout */
  --reader-column: 680px; --reader-sidebar: 300px; --rail-width: 224px;
  --surface-width-menu: 240px; --surface-width-panel: 340px; --surface-width-selection: 372px;
  --surface-edge: 14px; --surface-gap: 14px; --breakpoint-compact: 760px;

  /* Surface metrics */
  --panel-padding-block: 12px; --panel-padding-inline: 8px; --row-padding-block: 8px;
  --share-item-padding-block: 8px; --share-item-padding-inline: 10px;

  /* Motion */
  --duration-instant: 70ms; --duration-fast: 120ms; --duration-enter: 160ms; --duration-slow: 340ms;
  --ease-standard: ease; --ease-out: cubic-bezier(.23, 1, .32, 1); --ease-spring: cubic-bezier(.3, 1.4, .45, 1);
  --transition-color: color var(--duration-fast) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);
  --transition-surface: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);

  /* Elevation */
  --shadow-card: 0 6px 24px rgba(0, 0, 0, .45);
  --shadow-popover: 0 1px 2px rgba(0, 0, 0, .08), 0 16px 40px -16px rgba(0, 0, 0, .4);
  --shadow-modal: 0 20px 70px rgba(0, 0, 0, .48);

  /* Anchored surface */
  --surface-popover-bg: color-mix(in srgb, var(--color-chrome) 96%, transparent);
  --surface-popover-border: var(--border-default); --surface-popover-radius: var(--radius-popover);
  --surface-popover-blur: blur(16px) saturate(1.3); --surface-popover-shadow: var(--shadow-popover);

  /* Layers */
  --layer-reader: 5; --layer-feedback: 40; --layer-blank: 42; --layer-rail: 48; --layer-toolbar: 50;
  --layer-selection: 80; --layer-dialog: 90; --layer-banner: 95; --layer-settings: 100;
  --layer-popover: 110; --layer-palette: 120; --layer-toast: 150; --layer-lightbox: 220;

  /* Document rhythm */
  --doc-heading-1: 1.45em; --doc-heading-2: 1.22em; --doc-heading-3: 1.05em; --doc-heading-minor: .82em;
  --doc-code-size: .82em; --doc-block-code-size: .8em; --doc-paragraph-gap: .85em;
  --doc-list-indent: 1.35em; --doc-block-radius: var(--radius-control-lg);

  /* Dark is the no-attribute default. */
  --color-bg: #1a1918; --color-grid: #262422; --color-text: #cfccc4; --color-text-strong: #efece5;
  --color-text-muted: #94908a; --color-text-faint: #6d6963; --color-border: #2e2c29; --color-border-strong: #4c4945;
  --color-document: #201f1d; --color-document-head: #262523; --color-chrome: #1e1d1b; --color-code: #151412;
  --color-accent: #8faaf0; --color-on-accent: #12141c; --color-edge: #3d3b37;
  --color-hover: rgba(143, 170, 240, .16); --color-selection: rgba(143, 170, 240, .30);
  --color-warning: #d9a866; --color-success: #5fbd8d; --color-skeleton: rgba(255, 255, 255, .06);
  --color-scrim: rgba(26, 25, 24, .62);

  /* Compatibility aliases */
  --bg: var(--color-bg); --grid: var(--color-grid); --fg: var(--color-text); --fg-bold: var(--color-text-strong);
  --fg-dim: var(--color-text-muted); --fg-faint: var(--color-text-faint); --border: var(--color-border);
  --border-focus: var(--color-border-strong); --node-bg: var(--color-document); --node-head: var(--color-document-head);
  --bar-bg: var(--color-chrome); --code-bg: var(--color-code); --accent: var(--color-accent);
  --accent-contrast: var(--color-on-accent); --edge: var(--color-edge); --hl: var(--color-hover);
  --hl-strong: var(--color-selection); --warn: var(--color-warning); --sk-base: var(--color-skeleton);
  --shadow: var(--shadow-card);
  --popover-bg: var(--surface-popover-bg); --popover-border: var(--surface-popover-border);
  --popover-radius: var(--surface-popover-radius); --popover-blur: var(--surface-popover-blur);
  --popover-shadow: var(--surface-popover-shadow); --popover-speed: var(--duration-fast); --popover-ease: var(--ease-out);
}

html[data-theme="light"] {
  --color-bg: #f5f3ee; --color-grid: #e5e2da; --color-text: #3b3833; --color-text-strong: #191713;
  --color-text-muted: #7c776d; --color-text-faint: #a9a498; --color-border: #e4e1d8; --color-border-strong: #b9b4a8;
  --color-document: #fdfcfa; --color-document-head: #f7f5f0; --color-chrome: #faf9f5; --color-code: #f1eee7;
  --color-accent: #3b5bcc; --color-on-accent: #fff; --color-edge: #cdc9be;
  --color-hover: rgba(59, 91, 204, .10); --color-selection: rgba(59, 91, 204, .22);
  --color-warning: #a3690e; --color-success: #268c60; --color-skeleton: rgba(59, 55, 45, .08);
  --color-scrim: rgba(245, 243, 238, .62);
  --shadow-card: 0 4px 18px rgba(28, 25, 18, .08); --shadow-modal: 0 20px 70px rgba(0, 0, 0, .24);
}

html[data-theme="dark"] {
  --color-bg: #1a1918; --color-grid: #262422; --color-text: #cfccc4; --color-text-strong: #efece5;
  --color-text-muted: #94908a; --color-text-faint: #6d6963; --color-border: #2e2c29; --color-border-strong: #4c4945;
  --color-document: #201f1d; --color-document-head: #262523; --color-chrome: #1e1d1b; --color-code: #151412;
  --color-accent: #8faaf0; --color-on-accent: #12141c; --color-edge: #3d3b37;
  --color-hover: rgba(143, 170, 240, .16); --color-selection: rgba(143, 170, 240, .30);
  --color-warning: #d9a866; --color-success: #5fbd8d; --color-skeleton: rgba(255, 255, 255, .06);
  --color-scrim: rgba(26, 25, 24, .62);
  --shadow-card: 0 6px 24px rgba(0, 0, 0, .45); --shadow-modal: 0 20px 70px rgba(0, 0, 0, .48);
}

@media (max-width: 760px) {
  :root { --surface-edge: 8px; --surface-gap: 8px; --space-page-x: 20px; }
}

@media (prefers-reduced-motion: reduce) {
  :root { --duration-instant: 0ms; --duration-fast: 0ms; --duration-enter: 0ms; --duration-slow: 0ms; }
}`;
