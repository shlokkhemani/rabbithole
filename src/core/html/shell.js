import { buttonMarkup, iconButtonMarkup } from "./button-markup.js";
import { iconSvg } from "./icons.js";

/*
 * Extracted from the former canvas.js monolith. Keep this string as the exact
 * self-contained browser payload; behavior is verified by the inline-script
 * node --check gate.
 */
export const CANVAS_SHELL = `
<div id="reader">
  <div id="reader-top">
    <nav id="breadcrumb" aria-label="Breadcrumb"></nav>
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
          <button id="composer-send" class="send-btn" title="Send (Enter) · New line (Shift+Enter)" aria-label="Send follow-up" disabled>${iconSvg("send")}</button>
        </div>
      </div>
    </div>
    <div id="reader-side"></div>
  </div>
</div>

<div id="viewport"><div id="world"><svg id="edges"></svg></div></div>
<div id="toolbar">
  ${iconButtonMarkup({ id: "t-rail", title: "Rabbitholes · S", ariaLabel: "Toggle rabbitholes", ariaExpanded: "false", ariaControls: "web-rail", svgIconHtml: iconSvg("rail") })}
  ${iconButtonMarkup({ id: "t-new", title: "New Rabbithole · N", ariaLabel: "New Rabbithole", svgIconHtml: iconSvg("new") })}
  <span class="sep" id="app-sep"></span>
  ${buttonMarkup({ id: "t-reader", title: "Back to reading", label: "Reader", svgIconHtml: iconSvg("reader") })}
  <span class="sep"></span>
  <span class="zoom-controls">
    ${iconButtonMarkup({ id: "t-zout", title: "Zoom out", ariaLabel: "Zoom out", svgIconHtml: iconSvg("zoom-out") })}
    ${buttonMarkup({ id: "zoom-label", title: "Zoom to 100%", ariaLabel: "Zoom to 100%", label: "100%" })}
    ${iconButtonMarkup({ id: "t-zin", title: "Zoom in", ariaLabel: "Zoom in", svgIconHtml: iconSvg("zoom-in") })}
  </span>
  ${iconButtonMarkup({ id: "t-frame", title: "Frame everything · F", ariaLabel: "Frame everything · F", svgIconHtml: iconSvg("frame") })}
  ${iconButtonMarkup({ id: "t-tidy", title: "Tidy up layout · T", ariaLabel: "Tidy up layout · T", svgIconHtml: iconSvg("tidy") })}
  <span class="sep"></span>
  ${iconButtonMarkup({ id: "t-share", title: "Share, export, synthesize", ariaLabel: "Share, export, synthesize", ariaHaspopup: "menu", ariaControls: "sharemenu", ariaExpanded: "false", svgIconHtml: iconSvg("share") })}
  <span class="sep"></span>
  ${iconButtonMarkup({ id: "t-theme", title: "Toggle theme", ariaLabel: "Toggle theme", svgIconHtml: iconSvg("theme") })}
  ${iconButtonMarkup({ id: "t-settings", title: "Model settings", ariaLabel: "Model settings", ariaExpanded: "false", svgIconHtml: iconSvg("settings") })}
  <span class="sep" id="act-sep" style="display:none"></span>
  ${iconButtonMarkup({ bare: true, className: "activity", id: "act-canvas", title: "Jump to it", ariaLabel: "Jump to active answer" })}
</div>

<div id="ask">
  <div class="ask-input">
    <textarea id="ask-text" rows="1" placeholder="Ask about this…"></textarea>
    ${iconButtonMarkup({ bare: true, className: "send-btn", id: "ask-go", title: "Send (Enter) · New line (Shift+Enter)", ariaLabel: "Ask", svgIconHtml: iconSvg("send") })}
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
    ${iconSvg("search")}
    <input id="pal-text" placeholder="Search this Rabbithole…" aria-label="Search this Rabbithole" aria-controls="pal-results" aria-autocomplete="list" autocomplete="off" spellcheck="false">
    <kbd>esc</kbd>
  </div>
  <div id="pal-results" role="listbox" aria-label="Search results"></div>
</div></div>

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
