import { DESIGN_TOKENS } from "./tokens.js";

/*
 * Extracted from the former canvas.js monolith. Keep this string as the exact
 * self-contained browser payload; behavior is verified by the inline-script
 * node --check gate.
 */
export const CANVAS_STYLES = `${DESIGN_TOKENS}
* { box-sizing: border-box; margin: 0; padding: 0; }
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
html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
body {
  font: var(--text-base)/var(--leading-body) var(--font-ui); background: var(--bg); color: var(--fg);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 18%, transparent); border-radius: 5px; border: 2.5px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--fg) 30%, transparent); border: 2.5px solid transparent; background-clip: padding-box; }

.tool-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--control-gap); background: none; border: none; color: var(--fg-dim); cursor: pointer; font: inherit; font-size: var(--text-body); padding: var(--space-2) var(--control-pad-x-compact); border-radius: var(--radius-control); white-space: nowrap; transition: var(--transition-color); }
.tool-btn:hover { color: var(--fg-bold); background: var(--hl); }
.tool-btn:focus { outline: none; }
.tool-btn:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.tool-btn svg { display: block; width: 16px; height: 16px; flex-shrink: 0; }

/* One send button everywhere a question leaves the page: neutral while there's
   nothing to send, accent the moment there is. */
.send-btn { width: var(--control-h-sm); height: var(--control-h-sm); border-radius: var(--radius-pill); border: none; flex-shrink: 0; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: color-mix(in srgb, var(--fg) 9%, transparent); color: var(--fg-faint);
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-out); }
.send-btn:disabled { cursor: default; }
.send-btn:not(:disabled) { background: var(--accent); color: var(--accent-contrast); }
.send-btn:not(:disabled):hover { filter: brightness(1.07); }
/* optical: circular send button press feedback */
.send-btn:not(:disabled):active { transform: scale(0.97); }
.send-btn svg { display: block; }

/* ---------- shared document typography (em-based so text zoom scales it) ---------- */
.md { font-family: var(--font-doc); line-height: 1.72; color: var(--fg); font-kerning: normal; overflow-wrap: break-word; }
.md h1, .md h2, .md h3 { font-family: var(--font-ui); font-weight: 600; color: var(--fg-bold); line-height: 1.3; }
.md h1 { font-size: 1.45em; letter-spacing: -0.018em; margin: 1.5em 0 0.55em; }
.md h2 { font-size: 1.22em; letter-spacing: -0.012em; margin: 1.6em 0 0.5em; }
.md h3 { font-size: 1.05em; letter-spacing: -0.008em; margin: 1.4em 0 0.4em; }
.md h4, .md h5, .md h6 { font-family: var(--font-ui); font-weight: 600; font-size: 0.82em; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-dim); margin: 1.6em 0 0.5em; }
.md h1:first-child, .md h2:first-child, .md h3:first-child, .md h4:first-child { margin-top: 0; }
.md p { margin: 0 0 0.85em; }
.md ul, .md ol { margin: 0.1em 0 0.95em; padding-left: 1.35em; }
.md li { margin: 0 0 0.3em; }
.md li::marker { color: var(--fg-faint); }
.md li > ul, .md li > ol { margin: 0.3em 0 0.35em; }
.md code { font-family: var(--font-mono); font-size: 0.82em; background: var(--code-bg); border-radius: 4px; padding: 0.12em 0.38em; }
.md pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.85em 1em; margin: 0.4em 0 1em; overflow-x: auto; overscroll-behavior-x: contain; line-height: 1.55; }
.md pre code { background: none; border: none; padding: 0; font-size: 0.8em; }
.md pre code.hljs { display: block; overflow-x: visible; padding: 0; color: var(--hljs-fg); background: transparent; }
.md code.hljs { background: transparent; padding: 0; }
.md .hljs { color: var(--hljs-fg); background: transparent; }
.md .hljs-doctag, .md .hljs-keyword, .md .hljs-meta .hljs-keyword, .md .hljs-template-tag, .md .hljs-template-variable, .md .hljs-type, .md .hljs-variable.language_ { color: var(--hljs-keyword); }
.md .hljs-title, .md .hljs-title.class_, .md .hljs-title.class_.inherited__, .md .hljs-title.function_ { color: var(--hljs-entity); }
.md .hljs-attr, .md .hljs-attribute, .md .hljs-literal, .md .hljs-meta, .md .hljs-number, .md .hljs-operator, .md .hljs-variable, .md .hljs-selector-attr, .md .hljs-selector-class, .md .hljs-selector-id { color: var(--hljs-constant); }
.md .hljs-regexp, .md .hljs-string, .md .hljs-meta .hljs-string { color: var(--hljs-string); }
.md .hljs-built_in, .md .hljs-symbol { color: var(--hljs-variable); }
.md .hljs-comment, .md .hljs-code, .md .hljs-formula { color: var(--hljs-comment); }
.md .hljs-name, .md .hljs-quote, .md .hljs-selector-tag, .md .hljs-selector-pseudo { color: var(--hljs-tag); }
.md .hljs-subst, .md .hljs-emphasis, .md .hljs-strong { color: var(--hljs-fg); }
.md .hljs-section { color: var(--hljs-section); font-weight: 700; }
.md .hljs-bullet { color: var(--hljs-bullet); }
.md .hljs-emphasis { font-style: italic; }
.md .hljs-strong { font-weight: 700; }
.md .hljs-addition { color: var(--hljs-addition); background-color: var(--hljs-addition-bg); }
.md .hljs-deletion { color: var(--hljs-deletion); background-color: var(--hljs-deletion-bg); }
.md .katex { color: inherit; }
.md .katex-display { color: inherit; margin: 0.65em 0 1em; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }
.md .math-pending { position: relative; overflow: hidden; margin: 0.55em 0 1em; padding: 0.7em 0.9em; border: 1px solid var(--border); border-radius: 8px; background: var(--sk-base); color: var(--fg-dim); font-family: var(--font-ui); font-size: 0.86em; font-style: normal; }
.md .math-pending::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 9%, transparent), transparent); animation: math-pending-shimmer 1.35s ease-in-out infinite; }
.md .viz-pending { position: relative; overflow: hidden; margin: 0.55em 0 1em; padding: 0.7em 0.9em; border: 1px solid var(--border); border-radius: 8px; background: var(--sk-base); color: var(--fg-dim); font-family: var(--font-ui); font-size: 0.86em; font-style: normal; }
.md .viz-pending::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 9%, transparent), transparent); animation: math-pending-shimmer 1.35s ease-in-out infinite; }
.md .viz-fallback { margin: 0.55em 0 1em; border: 1px solid var(--border); border-radius: 8px; padding: 0.75em 0.9em; background: var(--node-bg); color: var(--fg); font-family: var(--font-ui); }
.md .viz-fallback-note { margin-bottom: 0.55em; color: var(--warn); font-size: 0.82em; font-weight: 600; }
.md .viz-fallback pre { margin: 0; }
.md blockquote { margin: 0.2em 0 1em; padding: 0.05em 0 0.05em 1em; border-left: 2px solid var(--border-focus); color: var(--fg-dim); font-style: italic; }
.md blockquote code { font-style: normal; }
.md a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.16em; text-decoration-color: color-mix(in srgb, var(--accent) 42%, transparent); }
.md a:hover { text-decoration-color: var(--accent); }
.md strong { font-weight: 700; color: inherit; }
.md table { border-collapse: collapse; margin: 0.4em 0 1em; font-family: var(--font-ui); font-size: 0.82em; line-height: 1.5; display: block; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
.md th, .md td { padding: 0.5em 1.1em 0.5em 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
.md th { font-weight: 600; color: var(--fg-dim); font-size: 0.92em; letter-spacing: 0.02em; border-bottom-color: var(--border-focus); }
.md hr { border: none; border-top: 1px solid var(--border); margin: 1.8em auto; width: 55%; }
.md img { max-width: 100%; border-radius: 6px; }
.md .rh-img-frame { position: relative; display: inline-block; max-width: 100%; line-height: 0; vertical-align: top; margin: 0.15em 0 0.85em; }
.md .rh-img-frame[data-rh-resized="1"] { display: block; margin-left: auto; margin-right: auto; }
.md .rh-img-frame > img { display: block; width: auto; max-width: 100%; height: auto; cursor: zoom-in; user-select: none; -webkit-user-select: none; }
.md .rh-img-frame[data-rh-resized="1"] > img { width: 100%; }
.rh-img-handle { position: absolute; right: -3px; bottom: -3px; width: 15px; height: 15px; border: 1px solid color-mix(in srgb, var(--fg) 28%, transparent); border-radius: var(--radius-control); background: var(--node-bg); color: var(--fg-dim); cursor: nwse-resize; opacity: 0; transition: opacity var(--duration-fast) var(--ease-standard), background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard); }
.rh-img-handle::before { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; border-radius: 1px; }
.rh-img-frame:hover .rh-img-handle, .rh-img-handle:focus-visible { opacity: 1; }
.rh-img-handle:hover { background: var(--bar-bg); color: var(--fg-bold); }
.rh-img-handle:focus { outline: none; }
.rh-img-handle:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
html[data-theme="dark"] .md .rh-img-frame { padding: 8px; background: #f4f4f1; border: 1px solid color-mix(in srgb, var(--border) 60%, #f4f4f1); border-radius: 6px; }
html[data-theme="dark"] .md .rh-img-frame > img { color: #191713; }
.rh-lightbox { position: fixed; inset: 0; z-index: 220; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.82); cursor: zoom-out; touch-action: none; }
.rh-lightbox-dialog { display: contents; }
.rh-lightbox-img { display: block; max-width: 92vw; max-height: 92vh; border-radius: 8px; transform: translate(var(--rh-pan-x, 0px), var(--rh-pan-y, 0px)) scale(var(--rh-zoom, 1)); transform-origin: center center; cursor: grab; user-select: none; -webkit-user-select: none; }
.rh-lightbox-img:active { cursor: grabbing; }
html[data-theme="dark"] .rh-lightbox-img { padding: 8px; background: #f4f4f1; border: 1px solid color-mix(in srgb, var(--border) 60%, #f4f4f1); }
.md > *:last-child { margin-bottom: 0; }

.doc-content { cursor: auto; user-select: text; -webkit-user-select: text; }
.doc-content ::selection { background: var(--hl-strong); }
/* While the ask popup is open, focus sits in its textarea and the browser paints
   the document selection as inactive (near-invisible) — so we paint it ourselves. */
::highlight(rh-ask) { background-color: rgba(59,91,204,0.22); background-color: var(--hl-strong); }
.doc-content mark.hl { position: relative; background: var(--hl); color: inherit; border-radius: 2px; padding: 0.02em 1px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.doc-content mark.hl::after { content: ""; position: absolute; inset: -0.05em -2px; border-radius: 3px; background: var(--hl-strong); opacity: 0; pointer-events: none; transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1); }
.doc-content mark.mark-pending { border-bottom: 2px dotted color-mix(in srgb, var(--accent) 55%, transparent); }
.doc-content mark.mark-ready { border-bottom: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); }
.doc-content mark.mark-ready:hover, .doc-content mark.mark-pending:hover, .doc-content mark.mark-focus { background: var(--hl-strong); border-bottom-color: var(--accent); }
.doc-content mark.hl:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
/* Landing flash when a jump (FROM strip, ⌘K) brings you to a mark. */
.doc-content mark.mark-flash::after { opacity: 1; }

/* ---------- loading (pending answers) ---------- */
.shimmer-text {
  font-weight: 500; color: var(--fg-dim);
}
.loading { padding: 0.2em 0; }
.loading-status { display: flex; align-items: center; gap: 9px; font-family: var(--font-ui); font-size: 12px; margin-bottom: 0.9em; }
.loading-bunny { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 22px; line-height: 1;
  color: var(--fg-dim); transform-origin: 50% 100%; animation: bunny-hop 1.45s infinite; }
.loading-status svg { display: block; width: 20px; height: 20px; overflow: visible; }
.loading-time { color: var(--fg-faint); font-variant-numeric: tabular-nums; font-size: 11px; }
.ll-stalled, .ll-closed { display: none; color: var(--fg-faint); font-weight: 500; }
body.agent-down .ll-live { display: none; }
body.agent-down:not(.session-over) .ll-stalled { display: inline; }
body.session-over .ll-closed { display: inline; }
.sk-line { height: 0.58em; border-radius: 3px; margin: 0.72em 0;
  background: var(--sk-base); }
.sk-line.w1 { width: 96%; } .sk-line.w2 { width: 88%; } .sk-line.w3 { width: 93%; } .sk-line.w4 { width: 61%; }
body.agent-down .loading .sk-line, body.session-over .loading .sk-line { animation: none; opacity: 0.45; }
body.agent-down .shimmer-text, body.session-over .shimmer-text { color: var(--fg-faint); }
body.agent-down .loading-bunny, body.session-over .loading-bunny, body.frozen .loading-bunny { animation: none; }
@keyframes bunny-hop {
  0% { transform: translateY(0) scaleY(1); animation-timing-function: cubic-bezier(0.24, 0.72, 0.22, 1); }
  18% { transform: translateY(-3px) scaleY(1.02); animation-timing-function: cubic-bezier(0.42, 0, 0.65, 0.34); }
  34% { transform: translateY(0) scaleY(0.92); animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1); }
  42%, 100% { transform: translateY(0) scaleY(1); }
}

/* ---------- streaming (the answer arriving live) ---------- */
.stream-caret { display: inline-block; width: 0.5em; height: 0.92em; margin-left: 3px; vertical-align: -0.08em; border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 78%, var(--fg)); animation: caret-breathe 1.15s ease-in-out infinite; }
@keyframes caret-breathe { 0%, 100% { opacity: 0.8; } 50% { opacity: 0.16; } }
@keyframes math-pending-shimmer { 100% { transform: translateX(100%); } }
body.agent-down .stream-caret, body.session-over .stream-caret { animation: none; opacity: 0.22; }
.stream-status { display: flex; align-items: baseline; gap: 9px; font-family: var(--font-ui); font-size: 12px; margin-top: 1em; }

@media (prefers-reduced-motion: reduce) {
  .loading-bunny, .stream-caret { animation: none; }
  .math-pending::after, .viz-pending::after { animation: none; }
  .send-btn, .doc-content mark.hl::after, .composer-inner, .node-act-divider, .tool-icon, .node-btn.danger, .node-font-btn,
  .node${""}::after, .node.node-enter, .nc-handle, .nc-inner, #ask, #sharemenu, #confirm { transition: none !important; }
  #ask, #sharemenu, #confirm, .node.node-enter { transform: none; }
  .node.node-enter { opacity: 1; }
}

/* ---------- READER ---------- */
/* The taskbar floats above; the reader clears it with top padding so the
   document and the "since" strip start below the chrome. */
#reader { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); z-index: 5; padding-top: var(--taskbar-clear); }
body.mode-canvas #reader { display: none; }
/* The lineage trail lives at the top of the document column and scrolls with it. */
#breadcrumb { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-family: var(--font-ui); font-size: 12.5px; margin-bottom: 22px; }
#breadcrumb:has(.crumb:only-child) { display: none; }
.crumb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; color: var(--fg-dim); cursor: pointer; }
.crumb:hover { color: var(--fg-bold); }
.crumb.current { color: var(--fg-bold); font-weight: 600; cursor: default; }
.crumb-sep { color: var(--fg-faint); flex-shrink: 0; }
/* "Since you left" — shown once on re-entry when answers arrived while away. */
#since { display: none; align-items: center; gap: 10px; padding: 7px 16px; font-family: var(--font-ui); font-size: 12px;
  color: var(--fg); border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--accent) 5%, var(--bar-bg)); flex-shrink: 0; }
#since.visible { display: flex; }
#since .since-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
#since .since-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#since .tool-btn { font-size: 12px; color: var(--accent); font-weight: 500; }
#since .tool-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
#since-x { background: none; border: none; color: var(--fg-faint); cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
#since-x:hover { color: var(--fg-bold); }
#reader-main { flex: 1; min-height: 0; overflow: auto; padding: 40px 48px 28px; overscroll-behavior: contain; scrollbar-gutter: stable; }
.reader-col { position: relative; max-width: var(--reader-column); margin: 0 auto; }
/* A PDF is already a complete reading surface. In Reader, give it the whole
   flex slot between the shared top chrome and composer instead of stacking a
   second toolbar and a second scrollbar around it. Threaded PDFs retain the
   normal outer reader flow so their conversation remains reachable. */
#reader-main.pdf-reader { padding-top: 0; }
#reader-main.pdf-reader-viewport { overflow: hidden; padding: 0; scrollbar-gutter: auto; }
#reader-main.pdf-reader-viewport .reader-col.pdf-reader-viewport { display: flex; width: 100%; max-width: none; height: 100%; min-height: 0; flex-direction: column; }
#reader-main.pdf-reader-viewport .doc-content.rh-pdf { flex: 1 1 auto; height: 100%; min-height: 0; }
#reader-main.pdf-reader-viewport .rh-pdf-scroll { flex: 1 1 auto; min-height: 0; max-height: none; }
#reader-main.pdf-reader-viewport #margin-notes { display: none; }
.reader-context { font-family: var(--font-ui); font-size: 12.5px; color: var(--fg-dim); border-left: 2px solid var(--border-focus); padding: 2px 0 2px 12px; margin-bottom: 26px; line-height: 1.55; }
.reader-context .rc-label { color: var(--fg-faint); text-transform: uppercase; font-size: 10px; letter-spacing: 0.08em; margin-right: 6px; }
/* The FROM strip is a live link back to the exact spot this branch grew from. */
.reader-context.linked { cursor: pointer; transition: border-color 0.15s; }
.reader-context.linked:hover { border-left-color: var(--accent); color: var(--fg); }
.reader-context.linked:hover .rc-go { color: var(--accent); }
.reader-context .rc-go { display: inline-block; color: var(--fg-faint); margin-left: 7px; transition: color 0.15s; }
/* ---------- margin notes ----------
   Branches sit beside the text like document comments: each card hangs in the
   right margin, top-aligned with the highlight it grew from (stacked apart when
   they'd collide). No sidebar, no toggling — the margin appears whenever the
   window is wide enough, and the inline marks carry narrow screens. */
#margin-notes { display: none; position: absolute; top: 0; left: calc(100% + 36px);
  width: min(250px, calc((100vw - var(--reader-column)) / 2 - 72px)); }
@media (min-width: 1180px) { #margin-notes { display: block; } }
.side-item { position: absolute; left: 0; width: 100%; border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 12px; cursor: pointer; background: var(--node-bg); font-family: var(--font-ui);
  transition: border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard); }
#margin-notes.settled .side-item { transition: border-color var(--duration-fast) var(--ease-standard),
  box-shadow var(--duration-fast) var(--ease-standard), top var(--duration-enter) var(--ease-standard); }
.side-item:hover { border-color: var(--border-focus); box-shadow: var(--shadow); }
.side-item .si-q { font-size: 12px; color: var(--fg-bold); line-height: 1.45; }
/* The highlight sits right beside the card, so the quote only appears on cards
   that have no inline mark to point at (region branches, unmatched anchors). */
.si-quote { display: none; font-size: 10.5px; color: var(--fg-faint); font-style: italic; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-item.unanchored .si-quote { display: block; }
.si-status { font-size: 10.5px; color: var(--fg-dim); margin-top: 6px; }
.si-muted { color: var(--fg-faint); }
.si-new { color: var(--accent); font-weight: 600; }
.si-new::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); margin-right: 5px; vertical-align: 1px; }
/* A pending branch streams its last lines live inside its sidebar tile — the
   answer is watchable from the moment the first words arrive. Bottom-aligned
   (the newest text) with the older text fading out at the top. */
.si-live { margin-top: 8px; max-height: 84px; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end;
  font-family: var(--font-doc); font-size: 11.5px; line-height: 1.55; color: var(--fg-dim);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px); mask-image: linear-gradient(to bottom, transparent 0, #000 24px); }
.si-live .md { font-size: 11.5px; color: var(--fg-dim); }
.si-live .md h1, .si-live .md h2, .si-live .md h3 { font-size: 1em; }
.si-live .md pre { padding: 0.4em 0.6em; margin: 0.3em 0; }
.lens-badge { display: inline-block; font-family: var(--font-ui); font-style: normal; font-size: 9.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); background: color-mix(in srgb, var(--accent) 7%, transparent);
  border-radius: 999px; padding: 1.5px 8px; vertical-align: 0.08em; }

/* ---------- follow-up conversation thread ---------- */
#thread { margin-top: 8px; }
.thread-rule { display: flex; align-items: center; gap: 10px; margin: 34px 0 24px; font-family: var(--font-ui); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-faint); }
.thread-rule::before, .thread-rule::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
.turn { margin-bottom: 28px; }
.turn-q { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.turn-q > span { max-width: 82%; background: var(--hl); border: 1px solid color-mix(in srgb, var(--accent) 16%, transparent); color: var(--fg-bold); font-family: var(--font-ui); font-size: 13.5px; line-height: 1.5; padding: 8px 14px; border-radius: 16px 16px 4px 16px; white-space: pre-wrap; overflow-wrap: break-word; }

/* ---------- composer (follow-up input) ---------- */
/* overflow:hidden + the same stable gutter as #reader-main keeps the pill's
   column pixel-aligned with the document text even when a classic scrollbar
   narrows the scroller above. */
#composer { flex-shrink: 0; padding: 10px 48px 16px; background: var(--bg); border-top: 1px solid var(--border); overflow: hidden; scrollbar-gutter: stable; }
.composer-inner { max-width: var(--reader-column); margin: 0 auto; display: flex; align-items: flex-end; gap: var(--space-4); background: var(--node-bg); border: var(--border-default); border-radius: var(--radius-conversation); padding: var(--space-4) var(--space-4) var(--space-4) var(--space-8); transition: border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard); }
.composer-inner:focus-within { border-color: var(--accent); box-shadow: var(--focus-field-shadow); }
.composer-inner.disabled { opacity: 0.6; }
#composer textarea { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--fg); font-family: var(--font-ui); font-size: 13.5px; line-height: 1.5; max-height: 140px; padding: 4px 0; }
#composer textarea::placeholder { color: var(--fg-faint); }

/* Phones get a reader designed around one vertical reading surface: the inline
   marks are the branch affordance, and the thread carries follow-ups. */
@media (hover: none), (pointer: coarse), (max-width: 760px) {
  #reader { height: 100dvh; min-height: -webkit-fill-available; overflow: hidden; }
  .crumb { max-width: min(72vw, 280px); }
  #reader-main { min-width: 0; overflow-x: hidden; overflow-y: auto; padding: 24px max(18px, env(safe-area-inset-right)) 28px max(18px, env(safe-area-inset-left));
    overscroll-behavior-y: contain; scrollbar-gutter: auto; touch-action: pan-y pinch-zoom; -webkit-overflow-scrolling: touch; }
  .reader-col { width: 100%; max-width: none; }
  #margin-notes { display: none; }
  .reader-context { margin-bottom: 20px; overflow-wrap: anywhere; }
  .turn-q > span { max-width: 92%; }
  .rh-origin-crop { max-width: 100%; }
  #composer { padding: 8px max(12px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    overflow: hidden; scrollbar-gutter: auto; }
  .composer-inner { width: 100%; padding: 6px 6px 6px 12px; }
  #composer textarea { min-height: 32px; font-size: 16px; line-height: 1.4; }
  #composer .send-btn { width: 44px; height: 44px; }
}

/* ---------- CANVAS ---------- */
#viewport { position: fixed; inset: 0; overflow: hidden; cursor: grab; display: none; touch-action: pan-x pan-y;
  background-color: var(--bg); background-image: radial-gradient(var(--grid) 1px, transparent 1px); background-size: 26px 26px; }
body.mode-canvas #viewport { display: block; }
#viewport.panning { cursor: grabbing; }
#viewport.pinching { cursor: zoom-in; }
#canvas-gesture-plane { position: absolute; inset: 0; touch-action: none; }
#world { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
#edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
#edges path { stroke: var(--edge); stroke-width: 1.5; fill: none; transition: stroke 0.22s ease; }
/* Hover wakes an edge gently — a lean toward the accent, not a costume change. */
#edges path.edge-hl { stroke: color-mix(in srgb, var(--accent) 45%, var(--edge)); }
#edges circle { fill: var(--edge); transition: fill 0.22s ease; }
#edges circle.anchored { fill: color-mix(in srgb, var(--accent) 65%, var(--edge)); }
#edges circle.edge-hl { fill: color-mix(in srgb, var(--accent) 60%, var(--edge)); }
/* overflow stays visible so the follow-up drawer can slide out below the card;
   the head carries its own top radius instead. */
.node { position: absolute; display: flex; flex-direction: column; background: var(--node-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.node${""}::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: color-mix(in srgb, var(--accent) 16%, transparent); opacity: 0; pointer-events: none; transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1); }
.node.node-enter { opacity: 0; transform: translateY(8px); transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1); }
.node.node-enter.entered { opacity: 1; transform: translateY(0); }
.node.root { border-color: var(--border-focus); }
/* The head stays minimal — just the title — so the card reads like a document.
   Controls sit in a right-edge overlay with secondary text sizing de-emphasized. */
.node-head { position: relative; display: flex; align-items: center; padding: var(--space-4) var(--space-6); background: var(--node-head); border-bottom: var(--border-default); border-radius: var(--radius-card) var(--radius-card) 0 0; cursor: grab; user-select: none; flex-shrink: 0; }
.node-head:active { cursor: grabbing; }
.node-title { font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; color: var(--fg-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.node-badge { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-right: 7px; flex: 0 0 14px; color: var(--fg-dim); cursor: default; }
.node-badge svg { display: block; width: 14px; height: 14px; }
.node-acts { position: absolute; top: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 0; padding: 0 7px 0 30px; pointer-events: none; background: linear-gradient(90deg, transparent, var(--node-head) 28%); border-radius: 0 var(--radius-card) 0 0; }
@media (hover: none) { .node-acts { position: static; padding: 0 0 0 8px; background: none; } }
.node-act-divider { width: 1px; height: 14px; margin: 0 3px; background: var(--border); flex-shrink: 0; opacity: 0; transition: opacity 150ms ease; }
.tool-icon, .node-btn { appearance: none; width: var(--control-h-xs); height: var(--control-h-xs); padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--radius-control); flex-shrink: 0; background-color: transparent; color: var(--fg-faint); cursor: pointer; pointer-events: auto; font-family: var(--font-ui); font-size: var(--text-ui); font-weight: var(--weight-medium); line-height: 1; transition: var(--transition-color); }
.tool-icon svg, .node-btn svg { display: block; width: 16px; height: 16px; flex-shrink: 0; }
.node-btn.danger, .node-font-btn { opacity: 0; transition: opacity 150ms ease, background-color 120ms ease, color 120ms ease; }
.node${""}:hover .node-btn.danger, .node${""}:hover .node-font-btn, .node${""}:hover .node-act-divider, .node-acts:focus-within .node-btn.danger, .node-acts:focus-within .node-font-btn, .node-acts:focus-within .node-act-divider { opacity: 1; }
.tool-icon:hover, .node-btn:hover { color: var(--fg-bold); background-color: color-mix(in srgb, currentColor 8%, transparent); }
.tool-icon:active, .node-btn:active { background-color: color-mix(in srgb, currentColor 13%, transparent); }
.tool-icon:focus, .node-btn:focus { outline: none; }
.tool-icon:focus-visible, .node-btn:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.node-btn.danger:hover { color: var(--warn); background-color: color-mix(in srgb, var(--warn) 12%, transparent); }
@media (hover: none) { .node-btn.danger, .node-font-btn, .node-act-divider { opacity: 1; } }
.node-body { padding: 14px 16px; overflow: auto; flex: 1; min-height: 0; overscroll-behavior: contain;
  touch-action: pan-x pan-y; -webkit-overflow-scrolling: touch; }
.node-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, var(--border-focus) 50%); border-bottom-right-radius: 9px; opacity: 0.5; }
.node-resize:hover { opacity: 1; }
.node.collapsed .node-body, .node.collapsed .node-resize, .node.collapsed .node-composer { display: none; }
.node.collapsed { height: auto !important; }
.node.collapsed .node-head { border-radius: var(--radius-card); border-bottom: none; }
/* Unread answers wear a small accent dot until first opened. */
.node.unread .node-title::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: 1px; }
/* Landing flash when ⌘K jumps the canvas to a card. */
.node.flash::after { opacity: 1; }

/* Follow-ups live in a drawer tucked under each card. Hovering the card makes a
   small "+ Follow-up" handle peek out beneath the bottom edge; clicking it slides
   the full-width composer out from underneath. The card itself never changes —
   the drawer is its own rounded surface resting a 5px hairline below it, with the
   card's shadow falling across it (that's the "underneath" cue). The clip line
   sits exactly at the card's bottom edge, so the slide genuinely emerges from
   beneath. Offsets: the wrapper hangs 1px below the padding box (flush under the
   card's bottom border) and 11px past each side (1px border + 10px of clip
   padding), so the drawer's edges land exactly on the card's outer edges. */
.node-composer { position: absolute; top: calc(100% + 1px); left: -11px; right: -11px; pointer-events: none; }
/* While open, the wrapper (incl. the hairline gap) hit-tests as part of the card,
   so crossing from card to drawer never fires the card's mouseleave tuck-in. */
.node-composer.open { pointer-events: auto; }
.nc-clip { padding: 0 10px 26px; overflow: hidden; }
.nc-handle { position: absolute; top: 0; left: 50%; transform: translate(-50%, 0); display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-ui); font-size: 10.5px; font-weight: 500; letter-spacing: 0.02em; color: var(--fg-dim);
  background: var(--node-bg); border: var(--border-default); border-top: none; border-radius: 0 0 var(--radius-card) var(--radius-card);
  padding: 3.5px 11px 4.5px; cursor: pointer; opacity: 0; pointer-events: none; box-shadow: 0 4px 10px -6px rgba(0,0,0,0.3);
  transition: opacity var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard); }
@media (hover: hover) and (pointer: fine) {
  .node${""}:hover .nc-handle { opacity: 1; pointer-events: auto; }
}
.nc-handle:hover { color: var(--fg-bold); }
.nc-plus { font-size: 13px; line-height: 1; font-weight: 400; color: var(--accent); }
/* a parked draft marks the handle with a small accent dot */
.node-composer.nc-draft .nc-handle::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
.node-composer.open .nc-handle { opacity: 0; pointer-events: none; }
.nc-inner { display: flex; align-items: flex-end; gap: var(--control-gap); margin-top: 5px; background: var(--node-bg); border: var(--border-default); border-radius: var(--radius-card); padding: 5px 5px 5px var(--space-6); box-shadow: var(--shadow-card); pointer-events: auto;
  transform: translateY(calc(-100% - 34px)); opacity: 0;
  transition: transform var(--duration-slow) var(--ease-spring), opacity var(--duration-enter) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard); }
.node-composer.open .nc-inner { transform: translateY(0); opacity: var(--nc-op, 1); }
.nc-inner:focus-within { border-color: var(--accent); box-shadow: var(--focus-field-shadow), var(--shadow-card); }
.nc-inner.disabled { --nc-op: 0.55; }
.nc-inner textarea { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--fg); font-family: var(--font-ui); font-size: 12px; line-height: 1.45; max-height: 90px; padding: 3px 0; }
.nc-inner textarea::placeholder { color: var(--fg-faint); }
.nc-inner .send-btn { width: 22px; height: 22px; }
.nc-inner .send-btn svg { width: 12px; height: 12px; }
@media (hover: none), (pointer: coarse) { .nc-handle { opacity: 1; pointer-events: auto; transition: none; } .node-composer.open .nc-handle { opacity: 0; pointer-events: none; } }
.origin-quote { font-family: var(--font-doc); font-size: 12px; color: var(--fg-dim); border-left: 2px solid var(--border-focus); padding-left: 9px; margin-bottom: 12px; font-style: italic; }
.rh-origin-crop { display: block; width: fit-content; max-width: 58%; overflow: hidden; box-sizing: border-box; margin: 0 0 14px; padding: 0; border: 1px solid color-mix(in srgb, var(--border-focus) 42%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--node-bg) 94%, var(--fg) 6%); box-shadow: 0 1px 1px color-mix(in srgb, var(--fg) 8%, transparent); cursor: zoom-in; line-height: 0; }
.rh-origin-crop:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.rh-origin-crop:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.rh-origin-crop img { display: block; width: auto; max-width: 100%; height: auto; max-height: 180px; object-fit: contain; }
.rh-origin-crop-reader { margin-bottom: 24px; }
.rh-origin-crop-reader img { max-height: 260px; }

/* ---------- taskbar — the one persistent chrome row shared by both modes ----
   Floating pills on a pass-through row: tools on the left; share · theme ·
   settings and a separate Done pill pinned top right. Each mode's group leads
   with the button that takes you to the other mode, so the switch reads as an
   action ("Canvas" / "Reader"), never as state. */
:root { --taskbar-clear: 62px; }
#taskbar { position: fixed; top: 14px; left: 14px; right: 14px; z-index: 50; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; pointer-events: none; }
#taskbar > #tb-tools, #taskbar > #tb-session { flex: 0 0 auto; }
#tb-document { position: fixed; top: 14px; left: var(--rh-pdf-reader-center, 50%); display: flex; width: max-content; max-width: calc(100vw - 28px); min-width: 0; justify-content: center; transform: translateX(-50%); pointer-events: none; }
#tb-document:empty, body.mode-canvas #tb-document { display: none; }
#tb-session { display: flex; align-items: flex-start; gap: 10px; }
.tb-pill { display: flex; align-items: center; gap: var(--space-3); pointer-events: auto; background: var(--bar-bg); border: 1px solid var(--border); border-radius: 10px; padding: 7px 10px; box-shadow: var(--shadow); }
/* One control height for everything in the bar — icon or text, every button
   sits on the same 24px line, so the pills all read as one height. */
.tb-pill .tool-btn { height: var(--control-h-xs); padding-block: 0; font-size: var(--text-ui); }
.tb-pill .tool-icon { width: var(--control-h-xs); padding: 0; }
/* Done sits alone in its pill, so the pill is the button: hover reads on the
   pill edge, never as a highlight box inside a box. */
#tb-done-pill { transition: border-color var(--duration-fast) var(--ease-standard); }
#tb-done-pill:hover { border-color: var(--border-focus); }
#tb-done-pill .tool-btn:hover { background: none; }
.tb-pill .sep { width: 1px; height: 18px; background: var(--border); flex-shrink: 0; }
.tb-group { display: contents; }
body.mode-canvas .tb-group[data-mode="reader"] { display: none; }
body:not(.mode-canvas) .tb-group[data-mode="canvas"] { display: none; }
.zoom-controls { display: inline-flex; align-items: center; gap: 1px; margin-inline: -2px; }
.zoom-controls .tool-icon { width: var(--control-h-xs); height: var(--control-h-xs); }
#t-new svg { transform: scale(1.08); }
#zoom-label { height: 24px; min-width: 40px; padding: 0 4px; font-size: 11px; color: var(--fg-faint); text-align: center; font-variant-numeric: tabular-nums; }
@media (hover: none), (pointer: coarse), (max-width: 760px) {
  :root { --taskbar-clear: calc(max(8px, env(safe-area-inset-top)) + 62px); }
  /* The row collapses into a single scrollable bar; the session cluster stays
     sticky at the right edge so Done never scrolls out of reach. */
  #taskbar { top: max(8px, env(safe-area-inset-top));
    left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right));
    gap: 2px; align-items: center; justify-content: flex-start; pointer-events: auto;
    background: var(--bar-bg); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: var(--shadow); padding: 5px 6px; overflow-x: auto; overscroll-behavior-x: contain;
    touch-action: pan-x; scrollbar-width: none; }
  #taskbar::-webkit-scrollbar { display: none; }
  #tb-document { position: static; top: auto; left: auto; flex: 0 0 auto; transform: none; }
  .tb-pill { background: none; border: none; box-shadow: none; padding: 0; border-radius: 0; gap: 2px; flex: 0 0 auto; }
  #tb-session { position: sticky; right: 0; margin-left: auto; align-items: center; gap: 2px; background: var(--bar-bg); padding-left: 4px; }
  .tb-pill .tool-icon, .zoom-controls .tool-icon { width: 44px; height: 44px; }
  .tb-pill .tool-btn { min-width: 44px; min-height: 44px; flex: 0 0 auto; }
  #zoom-label { height: 44px; min-width: 52px; padding-inline: 6px; font-size: 12px; }
  .tb-pill .sep { height: 24px; flex: 0 0 1px; }
}

/* ---------- ask popup — a small command palette for the selection ----------
   Two rows, nothing else: a borderless input with the shared circular send, and
   the four lenses behind a hairline. The selection stays lit in the document
   itself (Custom Highlight), so the popup repeats no context. Blank + ↵ =
   Explain, so the send stays armed. */
#ask { position: fixed; z-index: 80; width: 372px; visibility: hidden; opacity: 0; pointer-events: none;
  background: color-mix(in srgb, var(--bar-bg) 88%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.3); backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 16px 40px -16px rgba(0,0,0,0.4);
  transform: scale(0.97) translateY(-4px); transform-origin: top center;
  transition: opacity 160ms cubic-bezier(0.23, 1, 0.32, 1), transform 160ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 160ms; }
#ask.visible { visibility: visible; opacity: 1; pointer-events: auto; transform: scale(1) translateY(0); transition-delay: 0s; }
#ask:focus-within { border-color: var(--accent); box-shadow: var(--focus-field-shadow), var(--shadow); }
.ask-input { display: flex; align-items: flex-end; gap: 8px; padding: 8px 8px 8px 14px; }
.ask-input textarea { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--fg);
  font-family: var(--font-ui); font-size: 13px; line-height: 1.5; padding: 3px 0; min-height: 20px; max-height: 110px; }
.ask-input textarea::placeholder { color: var(--fg-faint); }
.ask-input .send-btn { width: 26px; height: 26px; }
.ask-lenses { display: flex; gap: 2px; padding: 5px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--fg) 2.5%, transparent); }
.lens { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; font-family: var(--font-ui); font-size: 11px; font-weight: 500;
  color: var(--fg-dim); background: none; border: none; border-radius: 8px; padding: 5.5px 2px; cursor: pointer; white-space: nowrap;
  transition: color 0.12s, background 0.12s; }
.lens:hover { color: var(--fg-bold); background: var(--hl); }
.lens:active { background: var(--hl-strong); }
.lens kbd { font-family: var(--font-ui); font-size: 9px; font-weight: 500; color: var(--fg-faint);
  background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 4px; padding: 1px 4.5px; line-height: 1.6; }
.lens:hover kbd { color: var(--fg-dim); background: color-mix(in srgb, var(--fg) 13%, transparent); }

/* Mobile selection is a separate interaction model: keep the desktop palette
   anchored to the text, but give touch users a stable, thumb-reachable sheet. */
#ask.mobile-sheet { width: min(420px, calc(var(--overlay-viewport-width, 100vw) - var(--surface-edge) * 2));
  max-height: max(0px, calc(var(--overlay-viewport-height, 100vh) - var(--surface-edge) * 2));
  overflow: auto; overscroll-behavior: contain; border-radius: 16px;
  transform: translateY(18px); transform-origin: bottom center; }
#ask.mobile-sheet.visible { transform: translateY(0); }
#ask.mobile-sheet .ask-input { align-items: center; gap: 10px; padding: 10px 10px 10px 14px; }
#ask.mobile-sheet .ask-input textarea { min-height: 24px; max-height: 96px; font-size: 16px; line-height: 1.45; }
#ask.mobile-sheet .ask-input .send-btn { width: 40px; height: 40px; flex: 0 0 40px; }
#ask.mobile-sheet .ask-lenses { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px;
  padding: 8px 8px max(8px, env(safe-area-inset-bottom)); }
#ask.mobile-sheet .lens { min-height: 46px; padding: 10px 8px; font-size: 13px;
  color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
#ask.mobile-sheet .lens:active { background: var(--hl-strong); }
#ask.mobile-sheet .lens kbd { display: none; }

/* ---------- ⌘K palette — search the whole hole ---------- */
#palette { position: fixed; inset: 0; z-index: 120; display: none; background: color-mix(in srgb, var(--bg) 35%, transparent); }
#palette.visible { display: block; }
#palette-panel { width: min(560px, 92vw); margin: 13vh auto 0; background: color-mix(in srgb, var(--bar-bg) 92%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(1.3); backdrop-filter: blur(20px) saturate(1.3);
  border: var(--border-default); border-radius: var(--radius-popover); overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 24px 60px -20px rgba(0,0,0,0.45); }
.pal-input { display: flex; align-items: center; gap: 10px; padding: 13px 15px; }
.pal-input svg { flex-shrink: 0; color: var(--fg-faint); }
.pal-input input { flex: 1; border: none; outline: none; background: transparent; color: var(--fg); font-family: var(--font-ui); font-size: 14px; }
.pal-input input::placeholder { color: var(--fg-faint); }
.pal-input kbd, .pal-kbd { font-family: var(--font-ui); font-size: 9.5px; font-weight: 500; color: var(--fg-faint);
  background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 4px; padding: 2px 6px; }
#pal-results { max-height: 340px; overflow: auto; overscroll-behavior: contain; padding: 6px; border-top: 1px solid var(--border); }
#pal-results:empty { display: none; }
.pal-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.pal-item.sel { background: var(--hl); }
.pal-t { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--fg-bold); min-width: 0; }
.pal-t .pal-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pal-kbd { margin-left: auto; line-height: 1.4; flex-shrink: 0; }
.pal-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.pal-t .lens-badge { flex-shrink: 0; }
.pal-t .pal-writing { flex-shrink: 0; font-size: 10.5px; color: var(--accent); font-weight: 500; }
.pal-s { font-size: 11.5px; color: var(--fg-dim); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-s mark { background: none; color: var(--fg-bold); font-weight: 600; }
.pal-empty { padding: 18px 12px 14px; text-align: center; font-size: 12px; color: var(--fg-faint); }

/* ---------- share menu ---------- */
#sharemenu { position: fixed; z-index: 110; min-width: 236px; visibility: hidden; opacity: 0; pointer-events: none; background: var(--popover-bg);
  -webkit-backdrop-filter: var(--popover-blur); backdrop-filter: var(--popover-blur);
  border: var(--surface-popover-border); border-radius: var(--surface-popover-radius); padding: var(--space-3); overflow: hidden;
  box-shadow: var(--popover-shadow); transform: translateY(-4px); transform-origin: top right;
  transition: opacity var(--popover-speed) var(--popover-ease), transform var(--popover-speed) var(--popover-ease), visibility 0s linear var(--popover-speed); }
#sharemenu.visible { visibility: visible; opacity: 1; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
.sm-item { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; background: none; border: none; cursor: pointer;
  font-family: var(--font-ui); font-size: var(--text-body); color: var(--fg); border-radius: var(--radius-control-lg); padding: var(--share-item-padding-block) var(--share-item-padding-inline); }
.sm-item:hover { background: var(--hl); color: var(--fg-bold); }
.sm-item .sm-ic { width: 16px; text-align: center; color: var(--fg-dim); flex-shrink: 0; }
.sm-item:hover .sm-ic { color: var(--fg-bold); }
.sm-sep { height: 1px; background: var(--border); margin: 5px 8px; }

/* ---------- delete confirm popover ---------- */
#confirm { position: fixed; z-index: var(--layer-popover); visibility: hidden; opacity: 0; pointer-events: none; background: var(--surface-popover-bg); border: var(--surface-popover-border); border-radius: var(--surface-popover-radius);
  -webkit-backdrop-filter: var(--surface-popover-blur); backdrop-filter: var(--surface-popover-blur);
  padding: var(--space-5) var(--space-6); box-shadow: var(--surface-popover-shadow); font-family: var(--font-ui); font-size: var(--text-ui); color: var(--fg);
  transform: scale(0.97) translateY(-4px); transform-origin: top center;
  transition: opacity 125ms cubic-bezier(0.23, 1, 0.32, 1), transform 125ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s linear 125ms; }
#confirm.visible { visibility: visible; opacity: 1; pointer-events: auto; transform: scale(1) translateY(0); transition-delay: 0s; }
#confirm .cf-msg { margin-bottom: 9px; color: var(--fg-bold); font-weight: 500; }
#confirm .cf-row { display: flex; gap: 6px; justify-content: flex-end; }
#confirm button { font-family: var(--font-ui); font-size: 11.5px; border-radius: 6px; padding: 4px 11px; cursor: pointer; border: 1px solid var(--border); background: none; color: var(--fg-dim); }
#confirm button:hover { color: var(--fg-bold); border-color: var(--border-focus); }
#confirm button.cf-remove { background: var(--warn); border-color: var(--warn); color: var(--accent-contrast); font-weight: 600; }
#confirm button.cf-remove:hover { filter: brightness(1.08); color: var(--accent-contrast); }

/* ---------- frozen (exported snapshot) ---------- */
body.frozen #tb-done-pill, body.frozen .nc-handle, body.frozen #since, body.frozen .node-btn.danger { display: none !important; }
body.frozen .ll-closed { display: none !important; }
body.frozen.session-over .ll-frozen { display: inline; }
.ll-frozen { display: none; color: var(--fg-faint); font-weight: 500; }

/* ---------- status banner + hint ---------- */
#banner { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 95; display: none; align-items: flex-start; gap: 10px; max-width: min(560px, 92vw); background: var(--bar-bg); border: 1px solid var(--border); border-left: 3px solid var(--fg-faint); border-radius: 10px; padding: 10px 12px 10px 14px; box-shadow: var(--shadow); font-size: 12.5px; line-height: 1.55; color: var(--fg); }
#banner.visible { display: flex; }
#banner.warn { border-left-color: var(--warn); }
#banner .banner-title { font-weight: 600; color: var(--fg-bold); display: block; margin-bottom: 1px; }
#banner-x { background: none; border: none; color: var(--fg-faint); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px; flex-shrink: 0; }
#banner-x:hover { color: var(--fg-bold); }

/* #hint carries transient feedback only ("that ask was undone…") — there is no
   persistent instruction bar; the UI has to explain itself. */
#hint { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 40; display: none; font-size: 11.5px; color: var(--fg); background: var(--bar-bg); border: 1px solid var(--border); border-radius: 20px; padding: 6px 14px; box-shadow: var(--shadow); pointer-events: none; max-width: 90vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hint.flash { display: block; }
body:not(.mode-canvas) #hint.flash { bottom: 84px; }

/* ---------- native PDF pages ---------- */
.doc-content.rh-pdf { display: flex; min-height: 0; flex-direction: column; background: var(--bg); }
.rh-pdf-scroll { position: relative; min-width: 0; max-width: 100%; max-height: min(76vh, 980px); overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; scrollbar-gutter: stable; }
.node-body.pdf-body { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.node-body.pdf-body > .doc-content.rh-pdf { flex: 1 1 auto; height: 100%; }
.node .node-body.pdf-body .rh-pdf-scroll { flex: 1 1 auto; min-height: 0; max-height: none; }
.rh-pdf-stack { display: flex; box-sizing: border-box; width: max-content; min-width: 100%; flex-direction: column; align-items: center; gap: 18px; padding: 10px 12px 18px; }
.rh-pdf-page { position: relative; flex: 0 0 auto; overflow: hidden; background: white; outline: 1px solid var(--border); outline-offset: -1px; box-shadow: 0 2px 10px rgba(0,0,0,.12); contain: layout paint style; }
.rh-pdf-canvas-layer, .rh-pdf-canvas-generation, .rh-pdf-textlayer, .rh-pdf-marks { position: absolute; inset: 0; }
.rh-pdf-canvas-layer { z-index: 1; overflow: hidden; pointer-events: none; }
.rh-pdf-canvas-generation { transform-origin: 0 0; }
.rh-pdf-canvas-generation canvas { position: absolute; display: block; }
.rh-pdf-textlayer { z-index: 2; overflow: hidden; cursor: text; line-height: 1; text-align: initial; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; }
.rh-pdf-textlayer :is(span, br) { position: absolute; color: transparent; white-space: pre; cursor: text; transform-origin: 0 0; user-select: text; }
.rh-pdf-textlayer span.markedContent { top: 0; height: 0; }
.rh-pdf-textlayer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.rh-pdf-textlayer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.rh-pdf-textlayer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
.rh-pdf-marks { z-index: 3; overflow: visible; pointer-events: none; }
/* Rect marks sit over the white page render in both themes, so they take the
   accent wash directly: a lighter cousin of the live-selection tint by default,
   selection-strength on hover / when the answer card is hovered (mark-focus). */
.doc-content .rh-pdf-mark { pointer-events: auto; cursor: pointer; }
.doc-content .rh-pdf-mark polygon { fill: color-mix(in srgb, var(--accent) 18%, transparent); stroke: color-mix(in srgb, var(--accent) 32%, transparent); stroke-width: .75; vector-effect: non-scaling-stroke; transition: fill 0.15s, stroke 0.15s; }
.doc-content .rh-pdf-mark.mark-pending polygon { fill: color-mix(in srgb, var(--accent) 9%, transparent); stroke-dasharray: 3 2; }
.doc-content .rh-pdf-mark:hover polygon, .doc-content .rh-pdf-mark.mark-focus polygon { fill: color-mix(in srgb, var(--accent) 30%, transparent); stroke: color-mix(in srgb, var(--accent) 55%, transparent); }
.rh-pdf-textlayer span::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
.rh-pdf-box-mode .rh-pdf-page, .rh-pdf-box-mode .rh-pdf-textlayer { cursor: crosshair; user-select: none; }
.rh-pdf-box-draft { position: absolute; z-index: 4; border: 1.5px solid var(--accent); border-radius: 2px; pointer-events: none;
  box-shadow: 0 0 0 100vmax color-mix(in srgb, black 26%, transparent), inset 0 0 0 1px color-mix(in srgb, white 35%, transparent); }
.rh-pdf-box-draft::before, .rh-pdf-box-draft::after { content: ""; position: absolute; width: 8px; height: 8px; border: 2px solid var(--accent); }
.rh-pdf-box-draft::before { top: -2px; left: -2px; border-right: none; border-bottom: none; border-top-left-radius: 3px; }
.rh-pdf-box-draft::after { bottom: -2px; right: -2px; border-left: none; border-top: none; border-bottom-right-radius: 3px; }
.rh-pdf-box-draft.settled { box-shadow: 0 0 0 100vmax color-mix(in srgb, black 14%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); transition: box-shadow 180ms ease; }
.rh-pdf-toolbar { position: sticky; top: 0; z-index: 6; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px; box-sizing: border-box; width: 100%; min-height: 35px; padding: 4px 8px; flex: 0 0 auto; background: var(--node-head); border-bottom: 1px solid var(--border); border-radius: 0; }
.rh-pdf-toolbar-actions { display: flex; align-items: center; gap: var(--control-gap); flex-shrink: 0; }
.rh-pdf-region-actions { min-width: 0; justify-content: flex-start; }
.rh-pdf-document-actions { min-width: 0; justify-content: flex-end; }
.rh-pdf-toolbar-center { display: flex; min-width: 0; align-items: center; justify-content: center; }
.rh-pdf-toolbar-actions .node-btn span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rh-pdf-toolbar-actions .node-btn { width: auto; max-width: 100%; height: 26px; gap: 5px; padding: 0 9px; font-size: calc(var(--text-ui) - 1px); font-weight: var(--weight-normal, 400); border: 1px solid transparent; background: transparent; border-radius: var(--radius-control);
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease; }
.rh-pdf-toolbar-actions .node-btn:hover:not(:disabled) { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); border-color: color-mix(in srgb, var(--fg) 10%, transparent); }
.rh-pdf-toolbar-actions .node-btn:active:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.rh-pdf-toolbar-actions .node-btn:disabled { opacity: .55; cursor: default; }
.rh-pdf-toolbar-actions .node-btn svg { width: 13px; height: 13px; flex: 0 0 auto; }
.rh-pdf-toolbar-actions .node-btn.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
.rh-pdf-zoom-controls { display: inline-flex; align-items: center; gap: 1px; }
.rh-pdf-zoom-controls .node-btn { width: 26px; height: 26px; padding: 0; color: var(--fg-faint); }
.rh-pdf-zoom-controls .node-btn svg { width: 13px; height: 13px; }
.rh-pdf-zoom-controls .rh-pdf-zoom-value { width: auto; min-width: 44px; padding-inline: 4px; font-size: calc(var(--text-ui) - 1px); font-variant-numeric: tabular-nums; }
.rh-pdf-toolbar-message { max-width: 160px; overflow: hidden; color: var(--warn); font-family: var(--font-ui); font-size: calc(var(--text-ui) - 1px); text-overflow: ellipsis; white-space: nowrap; }
.rh-pdf-toolbar-message[hidden], .rh-pdf-zoom-controls[hidden] { display: none; }
/* Reader contributes its PDF controls to the one existing top-chrome row.
   Canvas PDFs deliberately keep the edge-to-edge toolbar in their card. */
#tb-document > .rh-pdf-reader-toolbar { position: static; z-index: auto; grid-template-columns: auto auto auto; width: max-content; min-width: 0; min-height: 40px; padding: 7px 10px; pointer-events: auto; background: var(--bar-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
@media (min-width: 761px) and (max-width: 959px) {
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-toolbar-actions .node-btn { width: 26px; padding-inline: 0; justify-content: center; }
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-toolbar-actions .node-btn span { display: none; }
}
@media (hover: none), (pointer: coarse), (max-width: 760px) {
  #reader-main.pdf-reader { padding-top: 0; }
  #reader-main.pdf-reader-viewport { padding-inline: 0; }
  #tb-document > .rh-pdf-reader-toolbar { width: max-content; min-height: 44px; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-toolbar-actions .node-btn { width: 44px; height: 44px; padding-inline: 0; justify-content: center; }
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-toolbar-actions .node-btn span { display: none; }
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-zoom-controls .node-btn { width: 44px; height: 44px; }
  #tb-document > .rh-pdf-reader-toolbar .rh-pdf-zoom-controls .rh-pdf-zoom-value { min-width: 52px; }
}
.rh-pdf-legacy { margin: 0 0 14px; padding: 10px 12px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 24%, var(--border)); border-radius: var(--radius-control); font-family: var(--font-ui); font-size: var(--text-ui); }
.rh-pdf-box-toggle.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
.rh-pdf-convert:not(:disabled) { color: var(--fg); background: color-mix(in srgb, var(--fg) 4%, transparent); border-color: color-mix(in srgb, var(--fg) 9%, transparent); }
.rh-pdf-convert.primary:not(:disabled) { color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
.rh-pdf-convert:disabled { opacity: .48; cursor: not-allowed; }
.rh-pdf-convert-progress { margin-bottom: 1em; }
.rh-pdf-convert-progress .loading-status { margin-bottom: 0; }
.rh-pdf-convert-progress.loading .loading-status { margin-bottom: 0.9em; }
.rh-pdf-convert-cancel { width: auto; height: 22px; padding: 0 9px; margin-left: 12px; font-size: calc(var(--text-ui) - 1px); border: 1px solid var(--border); border-radius: var(--radius-control);
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease; }
.rh-pdf-convert-cancel:hover:not(:disabled) { color: var(--fg); background: color-mix(in srgb, var(--fg) 4%, transparent); border-color: color-mix(in srgb, var(--fg) 12%, var(--border)); }
.rh-pdf-convert-cancel:disabled { opacity: .55; cursor: default; }
`;
