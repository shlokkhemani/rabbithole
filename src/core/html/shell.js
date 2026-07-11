import { buttonMarkup, iconButtonMarkup } from "./button-markup.js";

/*
 * Extracted from the former canvas.js monolith. Keep this string as the exact
 * self-contained browser payload; behavior is verified by the inline-script
 * node --check gate.
 */
export const CANVAS_SHELL = `
<div id="reader">
  <div id="reader-top">
    <div id="breadcrumb"></div>
    ${iconButtonMarkup({ bare: true, className: "activity", id: "act-reader", title: "Jump to it", ariaLabel: "Jump to active answer" })}
    ${buttonMarkup({ id: "r-textdown", title: "Smaller text", label: "A−" })}
    ${buttonMarkup({ id: "r-textup", title: "Larger text", label: "A+" })}
    ${buttonMarkup({ id: "r-canvas", title: "Open the spatial canvas", label: "⤢ Canvas" })}
    ${buttonMarkup({ id: "r-share", title: "Share, export, synthesize", label: "↗ Share", ariaHaspopup: "menu", ariaControls: "sharemenu", ariaExpanded: "false" })}
    ${iconButtonMarkup({ bare: true, className: "tool-btn", id: "r-theme", title: "Toggle theme", ariaLabel: "Toggle theme", icon: "◑" })}
    ${buttonMarkup({ id: "r-done", title: "End the session (the hole stays saved)", label: "Done" })}
  </div>
  <div id="since"><span class="since-dot"></span><span class="since-msg" id="since-msg"></span>${buttonMarkup({ id: "since-show", label: "Show me" })}${iconButtonMarkup({ bare: true, id: "since-x", title: "Dismiss", ariaLabel: "Dismiss activity notice", icon: "×" })}</div>
  <div id="reader-cols">
    <div id="reader-center">
      <div id="reader-main"></div>
      <div id="composer">
        <div class="composer-inner" id="composer-inner">
          <textarea id="composer-text" rows="1" placeholder="Ask a follow-up about this document…"></textarea>
          <button id="composer-send" class="send-btn" title="Send (↵)" aria-label="Send follow-up" disabled><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
    </div>
    <div id="reader-side"></div>
  </div>
</div>

<div id="viewport"><div id="world"><svg id="edges"></svg></div></div>
<div id="toolbar">
  ${iconButtonMarkup({ id: "t-rail", title: "Rabbitholes · S", ariaLabel: "Toggle rabbitholes", ariaExpanded: "false", ariaControls: "web-rail", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><rect x="2.5" y="2.75" width="11" height="10.5" rx="1.6"/><path d="M6.25 2.75v10.5"/><rect class="rail-fill" x="3.55" y="3.8" width="1.65" height="8.4" rx="0.82" fill="currentColor" stroke="none"/></svg>' })}
  ${iconButtonMarkup({ id: "t-new", title: "New Rabbithole · N", ariaLabel: "New Rabbithole", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/></svg>' })}
  <span class="sep" id="app-sep"></span>
  ${buttonMarkup({ id: "t-reader", title: "Back to reading", label: "Reader", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M3.75 3.25h4.5c1 0 1.8.8 1.8 1.8v7.7H5.15c-.77 0-1.4-.63-1.4-1.4z"/><path d="M5.15 12.75c-.77 0-1.4-.63-1.4-1.4s.63-1.4 1.4-1.4h4.9"/></svg>' })}
  <span class="sep"></span>
  ${iconButtonMarkup({ id: "t-zout", title: "Zoom out", ariaLabel: "Zoom out", icon: "−" })}
  ${buttonMarkup({ id: "zoom-label", title: "Zoom to 100%", ariaLabel: "Zoom to 100%", label: "100%" })}
  ${iconButtonMarkup({ id: "t-zin", title: "Zoom in", ariaLabel: "Zoom in", icon: "+" })}
  ${iconButtonMarkup({ id: "t-frame", title: "Frame everything · F", ariaLabel: "Frame everything · F", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M5.8 3.25H3.25V5.8"/><path d="M10.2 3.25h2.55V5.8"/><path d="M12.75 10.2v2.55H10.2"/><path d="M5.8 12.75H3.25V10.2"/></svg>' })}
  <span class="sep"></span>
  ${iconButtonMarkup({ id: "t-tidy", title: "Tidy up layout · T", ariaLabel: "Tidy up layout · T", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><rect x="6.25" y="2.5" width="3.5" height="2.75" rx="0.7"/><rect x="2.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><rect x="9.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><path d="M8 5.25v2.25"/><path d="M4.5 7.5h7"/><path d="M4.5 7.5v3.25"/><path d="M11.5 7.5v3.25"/></svg>' })}
  <span class="sep"></span>
  ${iconButtonMarkup({ id: "t-share", title: "Share, export, synthesize", ariaLabel: "Share, export, synthesize", ariaHaspopup: "menu", ariaControls: "sharemenu", ariaExpanded: "false", icon: "↗" })}
  ${iconButtonMarkup({ id: "t-theme", title: "Toggle theme", ariaLabel: "Toggle theme", icon: "◑" })}
  ${iconButtonMarkup({ id: "t-settings", title: "Model settings", ariaLabel: "Model settings", ariaExpanded: "false", svgIconHtml: '<svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><g transform="translate(12 12) scale(0.92) translate(-12 -12)"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g></svg>' })}
  <span class="sep" id="act-sep" style="display:none"></span>
  ${iconButtonMarkup({ bare: true, className: "activity", id: "act-canvas", title: "Jump to it", ariaLabel: "Jump to active answer" })}
</div>

<div id="ask">
  <div class="ask-input">
    <textarea id="ask-text" rows="1" placeholder="Ask about this… ↵ = Explain"></textarea>
    ${iconButtonMarkup({ bare: true, className: "send-btn", id: "ask-go", title: "Ask (↵)", ariaLabel: "Ask", svgIconHtml: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' })}
  </div>
  <div class="ask-lenses" id="ask-lenses">
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "explain" }, label: "Explain ", kbdHint: "1" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "eli5" }, label: "ELI5 ", kbdHint: "2" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "example" }, label: "Example ", kbdHint: "3" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "deeper" }, label: "Go Deeper ", kbdHint: "4" })}
  </div>
</div>

<div id="palette" hidden><div id="palette-panel">
  <div class="pal-input">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <input id="pal-text" placeholder="Search this Rabbithole…" aria-label="Search this Rabbithole" aria-controls="pal-results" aria-autocomplete="list" autocomplete="off" spellcheck="false">
    <kbd>esc</kbd>
  </div>
  <div id="pal-results" role="listbox" aria-label="Search results"></div>
</div></div>

<div id="peek" aria-hidden="true">
  <div class="peek-title"><span class="pal-dot" data-peek-unread hidden></span><span data-peek-title></span><span class="lens-badge" data-peek-badge hidden></span></div>
  <div class="peek-body md" data-peek-body></div>
  <div class="peek-hint">Open branch</div>
</div>

<div id="sharemenu" role="menu" aria-label="Share and export">
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-trail", role: "menuitem", tabIndex: -1, label: "Copy trail as Markdown", svgIconHtml: '<span class="sm-ic">⤷</span>' })}
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-doc", role: "menuitem", tabIndex: -1, label: "Copy document as Markdown", svgIconHtml: '<span class="sm-ic">⧉</span>' })}
  <div class="sm-sep"></div>
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-export", role: "menuitem", tabIndex: -1, label: "Download snapshot (.html)", svgIconHtml: '<span class="sm-ic">⇩</span>' })}
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-portable", role: "menuitem", tabIndex: -1, label: "Export Rabbithole (.rabbithole)", svgIconHtml: '<span class="sm-ic">⇣</span>' })}
  <div class="sm-sep" id="sm-sep2"></div>
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-synth", role: "menuitem", tabIndex: -1, label: "Synthesize this journey", svgIconHtml: '<span class="sm-ic">✦</span>' })}
</div>

<div id="confirm">
  <div class="cf-msg" id="cf-msg"></div>
  <div class="cf-row">${buttonMarkup({ bare: true, id: "cf-keep", label: "Keep" })}${buttonMarkup({ bare: true, className: "cf-remove", id: "cf-remove", label: "Remove" })}</div>
</div>

<div id="banner"><div class="banner-body"><span class="banner-title" id="banner-title" data-notice-title></span><span id="banner-msg" data-notice-message></span></div>${iconButtonMarkup({ bare: true, id: "banner-x", title: "Dismiss", ariaLabel: "Dismiss banner", icon: "×", dataAttrs: { noticeDismiss: "" } })}</div>
<div id="hint" data-notice-message></div>
`;
