import { isNoteNode } from "../core/hole/ask.js";
import { truncate } from "../core/hole/lens.js";
import { escapeHtml } from "../core/utils.js";
import { presetLabelForOrigin } from "./ask-presets.js";
import {
  createStandaloneNoteAtViewportCenter,
  ensureCanvasBuilt,
  frameAll,
  tidy,
  toggleCollapse,
} from "./canvas/index.js";
import { r } from "./canvas/runtime.js";
import { goToNode, mode, motionSourceFromEvent, nodes, paletteEl, palResults, palText } from "./core.js";
import { isCommandEnter } from "./input-intent.js";
import { createModuleLifecycle } from "./kit/scope.js";
import { openDialog } from "./primitives/dialog.js";
import { ensureNodeHtml } from "./renderer.js";
import { openSettingsSheet } from "./settings-sheet.js";

function defaultPaletteHooks() {
  return {
    hideAsk: function () {},
    closeShare: function () {},
    closeCardMenu: function () {},
  };
}

const paletteLifecycle = createModuleLifecycle({ defaults: defaultPaletteHooks });

// ===========================================================================
// ⌘K PALETTE — search the whole hole, plus canvas commands when opened there.
// ===========================================================================
function getPlain(node) {
  ensureNodeHtml(node);
  if (node._plainFor !== node.html) {
    const d = document.createElement("div");
    d.innerHTML = node.html || "";
    node._plainFor = node.html;
    node._plain = d.textContent || "";
  }
  return node._plain || "";
}
let palOpen = false,
  palSel = 0,
  palCanvasCommands = false,
  palDialog = null;
/** @type {any[]} */ let palItems = [];
/** @type {any[]} */ let palRows = [];
export function initPalette(hooks) {
  paletteLifecycle.register(hooks);
  disposePaletteResources(false);
  const paletteScope = paletteLifecycle.beginInit();
  try {
    palText.setAttribute("role", "combobox");
    palText.setAttribute("aria-expanded", "false");
    paletteScope.listen(palText, "input", function () {
      renderPalette(palText.value);
    });
    paletteScope.listen(palText, "keydown", onPaletteKeydown);
    paletteScope.listen(palResults, "click", onPaletteClick);
    paletteScope.listen(palResults, "mousemove", onPaletteMousemove);
    return disposePalette;
  } catch (error) {
    disposePalette();
    throw error;
  }
}

export function disposePalette() {
  disposePaletteResources(true);
}

function disposePaletteResources(resetHooks) {
  closePalette({ restoreFocus: false });
  paletteLifecycle.dispose(resetHooks);
  palOpen = false;
  palSel = 0;
  palItems = [];
  palCanvasCommands = false;
  palRows = [];
}

export function togglePalette() {
  if (palOpen) closePalette();
  else openPalette();
}
function openPalette() {
  palOpen = true;
  palCanvasCommands = mode === "canvas";
  paletteLifecycle.hooks.hideAsk();
  paletteLifecycle.hooks.closeShare();
  paletteLifecycle.hooks.closeCardMenu();
  paletteEl.classList.add("visible");
  palText.value = "";
  renderPalette("");
  if (palDialog) palDialog.close();
  palDialog = openDialog({
    dialog: document.getElementById("palette-panel"),
    backdrop: paletteEl,
    label: palText.getAttribute("aria-label") || palText.placeholder,
    initialFocus: palText,
    onClose: function () {
      palOpen = false;
      palCanvasCommands = false;
      paletteEl.classList.remove("visible");
      palText.setAttribute("aria-expanded", "false");
      palText.removeAttribute("aria-activedescendant");
      palDialog = null;
    },
  });
  palText.setAttribute("aria-expanded", "true");
}
function closePalette(settings) {
  if (palDialog) palDialog.close("programmatic", settings);
}
function onPaletteKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    movePalSel(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    movePalSel(-1);
  } else if (isCommandEnter(e)) {
    e.preventDefault();
    commitPal("keyboard");
  }
}
// Rank: title hits above quote/question hits above body hits; every token
// must appear somewhere. An empty query lists everything, newest first.
function renderPalette(q) {
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter(function (t) {
      return !!t;
    });
  let scored = [];
  for (const id in nodes) {
    const n = nodes[id];
    if (n._pendingDelete) continue;
    let score = 0,
      ok = true;
    let title = "",
      ask = "",
      body = "";
    if (tokens.length) {
      const rawTitle = n.title || "";
      if (n._searchTitleFor !== rawTitle) {
        n._searchTitleFor = rawTitle;
        n._searchTitle = rawTitle.toLowerCase();
      }
      title = n._searchTitle;
      const rawAsk = ((n.origin && n.origin.selected_text) || "") + " " + ((n.origin && n.origin.question) || "");
      if (n._searchAskFor !== rawAsk) {
        n._searchAskFor = rawAsk;
        n._searchAsk = rawAsk.toLowerCase();
      }
      ask = n._searchAsk;
      const rawBody = getPlain(n);
      if (n._searchBodyFor !== rawBody) {
        n._searchBodyFor = rawBody;
        n._searchBody = rawBody.toLowerCase();
      }
      body = n._searchBody;
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (title.indexOf(t) !== -1) score += title.indexOf(t) === 0 ? 40 : 30;
      else if (ask.indexOf(t) !== -1) score += 15;
      else if (body.indexOf(t) !== -1) score += 5;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    scored.push({ n: n, score: score });
  }
  scored.sort(function (a, b) {
    return b.score - a.score || (b.n._order || 0) - (a.n._order || 0);
  });
  scored = scored.slice(0, 12);
  palItems = [
    ...scored.map(function (s) {
      return { type: "node", id: s.n.id };
    }),
    ...paletteCommandItems(tokens),
  ];
  palSel = 0;
  if (!palItems.length) {
    palRows.forEach(function (row) {
      row.hidden = true;
    });
    palText.removeAttribute("aria-activedescendant");
    let empty = palResults.querySelector(".pal-empty");
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "pal-empty";
      palResults.appendChild(empty);
    }
    empty.textContent = tokens.length ? "Nothing in this hole matches that." : "";
    empty.hidden = !tokens.length;
    return;
  }
  const empty = palResults.querySelector(".pal-empty");
  if (empty) empty.hidden = true;
  const fragment = document.createDocumentFragment();
  palItems.forEach(function (item, i) {
    const row = palRows[i] || createPalRow(i);
    palRows[i] = row;
    row.hidden = false;
    row.dataset.idx = i;
    row.classList.toggle("sel", i === palSel);
    row._flag.textContent = "";
    row._flag.className = "";
    row._badge.hidden = true;
    row._kbd.hidden = true;
    row._snippet.hidden = item.type === "command";
    if (item.type === "command") {
      row._title.textContent = item.name;
      row._kbd.textContent = item.kbd || "";
      row._kbd.hidden = !item.kbd;
      fragment.appendChild(row);
      return;
    }
    const n = nodes[item.id];
    if (!n) return;
    row._title.textContent = n.title || "Untitled";
    if (n.status === "pending") {
      row._flag.className = "pal-writing";
      row._flag.textContent = "writing…";
    }
    if (n.origin && n.origin.lens) {
      row._badge.textContent = presetLabelForOrigin(n.origin);
      row._badge.hidden = false;
    }
    row._snippet.innerHTML = palSnippet(n, tokens);
    fragment.appendChild(row);
  });
  for (let i = palItems.length; i < palRows.length; i++) palRows[i].hidden = true;
  palResults.appendChild(fragment);
  syncPalActiveDescendant();
}
function createPalRow(index) {
  /** @type {HTMLDivElement & {_flag: HTMLSpanElement, _title: HTMLSpanElement, _badge: HTMLSpanElement, _kbd: HTMLElement, _snippet: HTMLDivElement}} */
  const row = /** @type {any} */ (document.createElement("div"));
  row.className = "pal-item";
  row.id = "pal-option-" + index;
  row.setAttribute("role", "option");
  const top = document.createElement("div");
  top.className = "pal-t";
  row._flag = document.createElement("span");
  row._title = document.createElement("span");
  row._title.className = "pal-title";
  row._badge = document.createElement("span");
  row._badge.className = "lens-badge";
  row._kbd = document.createElement("kbd");
  row._kbd.className = "pal-kbd";
  row._snippet = document.createElement("div");
  row._snippet.className = "pal-s";
  top.append(row._flag, row._title, row._badge, row._kbd);
  row.append(top, row._snippet);
  return row;
}
function syncPalActiveDescendant() {
  for (let i = 0; i < palRows.length; i++)
    palRows[i].setAttribute("aria-selected", i === palSel && !palRows[i].hidden ? "true" : "false");
  if (palRows[palSel] && !palRows[palSel].hidden) palText.setAttribute("aria-activedescendant", palRows[palSel].id);
  else palText.removeAttribute("aria-activedescendant");
}
// ⌘K is navigation and actions. Settings — global or per-card — are never
// here: the gear holds the first, the card ⋯ menu holds the second.
function paletteCommandItems(tokens) {
  const commands = [
    {
      type: "command",
      name: "Open settings",
      run: function () {
        openSettingsSheet({ trigger: document.getElementById("t-settings") });
      },
    },
  ];
  if (palCanvasCommands)
    commands.unshift(
      { type: "command", name: "New note", run: createStandaloneNoteAtViewportCenter },
      {
        type: "command",
        name: "Zoom to fit",
        run: function () {
          frameAll(true, "keyboard");
        },
      },
      {
        type: "command",
        name: "Tidy up layout",
        kbd: "T",
        run: function () {
          tidy("keyboard");
        },
      },
    );
  const out = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    const name = c.name.toLowerCase();
    let ok = true;
    for (let t = 0; t < tokens.length; t++) {
      if (name.indexOf(tokens[t]) === -1) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(c);
  }
  return out;
}
function palSnippet(n, tokens) {
  const body = getPlain(n);
  const lower = body.toLowerCase();
  for (let i = 0; i < tokens.length; i++) {
    const at = lower.indexOf(tokens[i]);
    if (at !== -1) {
      const start = Math.max(0, at - 34);
      const slice = (start > 0 ? "…" : "") + body.slice(start, start + 120);
      return hiTokens(slice, tokens);
    }
  }
  const quote = n.origin && n.origin.selected_text;
  if (quote) return "“" + hiTokens(truncate(quote, 90), tokens) + "”";
  const q = n.origin && n.origin.question;
  if (q) return hiTokens(truncate(q, 100), tokens);
  return escapeHtml(truncate(body, 100));
}
// Escape text while wrapping every token match in <mark>.
function hiTokens(text, tokens) {
  if (!tokens.length) return escapeHtml(text);
  let lower = text.toLowerCase(),
    out = "",
    i = 0;
  while (i < text.length) {
    let best = -1,
      bl = 0;
    for (let t = 0; t < tokens.length; t++) {
      const at = lower.indexOf(tokens[t], i);
      if (at !== -1 && (best === -1 || at < best)) {
        best = at;
        bl = tokens[t].length;
      }
    }
    if (best === -1) {
      out += escapeHtml(text.slice(i));
      break;
    }
    out += escapeHtml(text.slice(i, best)) + "<mark>" + escapeHtml(text.slice(best, best + bl)) + "</mark>";
    i = best + bl;
  }
  return out;
}
function movePalSel(delta) {
  if (!palItems.length) return;
  palSel = Math.max(0, Math.min(palItems.length - 1, palSel + delta));
  const items = palResults.querySelectorAll(".pal-item");
  for (let i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
  syncPalActiveDescendant();
  if (items[palSel]) items[palSel].scrollIntoView({ block: "nearest" });
}
function commitPal(source) {
  const item = palItems[palSel];
  if (!item) return;
  if (item.type === "command") {
    closePalette();
    item.run();
    return;
  }
  const node = nodes[item.id];
  closePalette();
  if (node) {
    const canUnfold = !isNoteNode(node);
    if (canUnfold && node.collapsed) {
      ensureCanvasBuilt();
      toggleCollapse(node);
    }
    goToNode(node, source);
    if (canUnfold) r.canvasMaintenance?.engageCard(node.id);
  }
}
function onPaletteClick(e) {
  const it = e.target.closest(".pal-item");
  if (!it) return;
  palSel = Number(it.dataset.idx) || 0;
  commitPal(motionSourceFromEvent(e));
}
function onPaletteMousemove(e) {
  const it = e.target.closest(".pal-item");
  if (!it) return;
  const idx = Number(it.dataset.idx) || 0;
  if (idx !== palSel) {
    palSel = idx;
    const items = palResults.querySelectorAll(".pal-item");
    for (let i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
    syncPalActiveDescendant();
  }
}
