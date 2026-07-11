import {
  goToNode,
  isUnread,
  lensLabel,
  mode,
  motionSourceFromEvent,
  nodes,
  palResults,
  palText,
  paletteEl,
  truncate
} from "./core.js";
import { escapeHtml } from "../core/utils.js";
import { frameAll, tidy } from "./canvas-view.js";
import { openDialog } from "./primitives/dialog.js";
import { createCleanupScope } from "./lifecycle.js";

function defaultPaletteHooks(){
  return {
    hideAsk: function(){},
    hidePeek: function(){},
    closeShare: function(){},
    hideConfirm: function(){}
  };
}

var paletteHooks = defaultPaletteHooks();
var paletteScope = null;

export function registerPaletteHooks(hooks) {
  Object.assign(paletteHooks, hooks || {});
}

  // ===========================================================================
  // ⌘K PALETTE — search the whole hole, plus canvas commands when opened there.
  // ===========================================================================
  function getPlain(node){
    if (node._plainFor !== node.html){
      var d = document.createElement("div");
      d.innerHTML = node.html || "";
      node._plainFor = node.html;
      node._plain = d.textContent || "";
    }
    return node._plain || "";
  }
  var palOpen = false, palSel = 0, palItems = [], palCanvasCommands = false, palDialog = null, palRows = [];
export function initPalette(){
  disposePaletteResources(false);
  paletteScope = createCleanupScope();
  try {
    palText.setAttribute("role", "combobox");
    palText.setAttribute("aria-expanded", "false");
    paletteScope.listen(palText, "input", function(){ renderPalette(palText.value); });
    paletteScope.listen(palText, "keydown", onPaletteKeydown);
    paletteScope.listen(palResults, "click", onPaletteClick);
    paletteScope.listen(palResults, "mousemove", onPaletteMousemove);
    return disposePalette;
  } catch (error) {
    disposePalette();
    throw error;
  }
}

export function disposePalette(){
  disposePaletteResources(true);
}

function disposePaletteResources(resetHooks){
  closePalette({ restoreFocus: false });
  var scope = paletteScope;
  paletteScope = null;
  if (scope) scope.dispose();
  palOpen = false;
  palSel = 0;
  palItems = [];
  palCanvasCommands = false;
  palRows = [];
  if (resetHooks) paletteHooks = defaultPaletteHooks();
}

export function togglePalette(){ if (palOpen) closePalette(); else openPalette(); }
export function openPalette(){
    palOpen = true;
    palCanvasCommands = mode === "canvas";
    paletteHooks.hideAsk(); paletteHooks.hidePeek(); paletteHooks.closeShare(); paletteHooks.hideConfirm();
    paletteEl.classList.add("visible");
    palText.value = "";
    renderPalette("");
    if (palDialog) palDialog.close();
    palDialog = openDialog({
      dialog: document.getElementById("palette-panel"),
      backdrop: paletteEl,
      label: palText.getAttribute("aria-label") || palText.placeholder,
      initialFocus: palText,
      onClose: function(){
        palOpen = false;
        palCanvasCommands = false;
        paletteEl.classList.remove("visible");
        palText.setAttribute("aria-expanded", "false");
        palText.removeAttribute("aria-activedescendant");
        palDialog = null;
      }
    });
    palText.setAttribute("aria-expanded", "true");
  }
export function closePalette(settings){
    if (palDialog) palDialog.close("programmatic", settings);
  }
  function onPaletteKeydown(e){
    if (e.key === "ArrowDown"){ e.preventDefault(); movePalSel(1); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); movePalSel(-1); }
    else if (e.key === "Enter"){ e.preventDefault(); commitPal("keyboard"); }
  }
  // Rank: title hits above quote/question hits above body hits; every token
  // must appear somewhere. An empty query lists everything, newest first.
  function renderPalette(q){
    var tokens = q.toLowerCase().split(/\s+/).filter(function(t){ return !!t; });
    var scored = [];
    for (var id in nodes){
      var n = nodes[id];
      var title = (n.title || "").toLowerCase();
      var ask = (((n.origin && n.origin.selected_text) || "") + " " + ((n.origin && n.origin.question) || "")).toLowerCase();
      var body = getPlain(n).toLowerCase();
      var score = 0, ok = true;
      for (var i = 0; i < tokens.length; i++){
        var t = tokens[i];
        if (title.indexOf(t) !== -1) score += title.indexOf(t) === 0 ? 40 : 30;
        else if (ask.indexOf(t) !== -1) score += 15;
        else if (body.indexOf(t) !== -1) score += 5;
        else { ok = false; break; }
      }
      if (!ok) continue;
      scored.push({ n: n, score: score });
    }
    scored.sort(function(a, b){ return (b.score - a.score) || ((b.n._order || 0) - (a.n._order || 0)); });
    scored = scored.slice(0, 12);
    palItems = scored.map(function(s){ return { type: "node", id: s.n.id }; }).concat(paletteCommandItems(tokens));
    palSel = 0;
    if (!palItems.length){
      palRows.forEach(function(row){ row.hidden = true; });
      palText.removeAttribute("aria-activedescendant");
      var empty = palResults.querySelector(".pal-empty");
      if (!empty){ empty = document.createElement("div"); empty.className = "pal-empty"; palResults.appendChild(empty); }
      empty.textContent = tokens.length ? "Nothing in this hole matches that." : "";
      empty.hidden = !tokens.length;
      return;
    }
    var empty = palResults.querySelector(".pal-empty");
    if (empty) empty.hidden = true;
    var fragment = document.createDocumentFragment();
    palItems.forEach(function(item, i){
      var row = palRows[i] || createPalRow(i);
      palRows[i] = row;
      row.hidden = false;
      row.dataset.idx = i;
      row.classList.toggle("sel", i === palSel);
      row._flag.textContent = "";
      row._flag.className = "";
      row._badge.hidden = true;
      row._kbd.hidden = true;
      row._snippet.hidden = item.type === "command";
      if (item.type === "command"){
        row._title.textContent = item.name;
        row._kbd.textContent = item.kbd;
        row._kbd.hidden = false;
        fragment.appendChild(row);
        return;
      }
      var n = nodes[item.id];
      if (!n) return;
      row._title.textContent = n.title || "Untitled";
      if (n.status === "pending"){ row._flag.className = "pal-writing"; row._flag.textContent = "writing…"; }
      else if (isUnread(n)) row._flag.className = "pal-dot";
      if (n.origin && (n.origin.synthesis || n.origin.lens)){
        row._badge.textContent = n.origin.synthesis ? "✦ Synthesis" : lensLabel(n.origin.lens);
        row._badge.hidden = false;
      }
      row._snippet.innerHTML = palSnippet(n, tokens);
      fragment.appendChild(row);
    });
    for (var i = palItems.length; i < palRows.length; i++) palRows[i].hidden = true;
    palResults.appendChild(fragment);
    syncPalActiveDescendant();
  }
  function createPalRow(index){
    var row = document.createElement("div");
    row.className = "pal-item";
    row.id = "pal-option-" + index;
    row.setAttribute("role", "option");
    var top = document.createElement("div"); top.className = "pal-t";
    row._flag = document.createElement("span");
    row._title = document.createElement("span"); row._title.className = "pal-title";
    row._badge = document.createElement("span"); row._badge.className = "lens-badge";
    row._kbd = document.createElement("kbd"); row._kbd.className = "pal-kbd";
    row._snippet = document.createElement("div"); row._snippet.className = "pal-s";
    top.append(row._flag, row._title, row._badge, row._kbd);
    row.append(top, row._snippet);
    return row;
  }
  function syncPalActiveDescendant(){
    for (var i = 0; i < palRows.length; i++) palRows[i].setAttribute("aria-selected", i === palSel && !palRows[i].hidden ? "true" : "false");
    if (palRows[palSel] && !palRows[palSel].hidden) palText.setAttribute("aria-activedescendant", palRows[palSel].id);
    else palText.removeAttribute("aria-activedescendant");
  }
  function paletteCommandItems(tokens){
    if (!palCanvasCommands) return [];
    var commands = [
      { type: "command", name: "Frame everything", kbd: "F", run: function(){ frameAll(true, "keyboard"); } },
      { type: "command", name: "Tidy up layout", kbd: "T", run: function(){ tidy("keyboard"); } }
    ];
    var out = [];
    for (var i = 0; i < commands.length; i++){
      var c = commands[i];
      var name = c.name.toLowerCase();
      var ok = true;
      for (var t = 0; t < tokens.length; t++){
        if (name.indexOf(tokens[t]) === -1){ ok = false; break; }
      }
      if (ok) out.push(c);
    }
    return out;
  }
  function palSnippet(n, tokens){
    var body = getPlain(n);
    var lower = body.toLowerCase();
    for (var i = 0; i < tokens.length; i++){
      var at = lower.indexOf(tokens[i]);
      if (at !== -1){
        var start = Math.max(0, at - 34);
        var slice = (start > 0 ? "…" : "") + body.slice(start, start + 120);
        return hiTokens(slice, tokens);
      }
    }
    var quote = n.origin && n.origin.selected_text;
    if (quote) return "“" + hiTokens(truncate(quote, 90), tokens) + "”";
    var q = n.origin && n.origin.question;
    if (q) return hiTokens(truncate(q, 100), tokens);
    return escapeHtml(truncate(body, 100));
  }
  // Escape text while wrapping every token match in <mark>.
  function hiTokens(text, tokens){
    if (!tokens.length) return escapeHtml(text);
    var lower = text.toLowerCase(), out = "", i = 0;
    while (i < text.length){
      var best = -1, bl = 0;
      for (var t = 0; t < tokens.length; t++){
        var at = lower.indexOf(tokens[t], i);
        if (at !== -1 && (best === -1 || at < best)){ best = at; bl = tokens[t].length; }
      }
      if (best === -1){ out += escapeHtml(text.slice(i)); break; }
      out += escapeHtml(text.slice(i, best)) + "<mark>" + escapeHtml(text.slice(best, best + bl)) + "</mark>";
      i = best + bl;
    }
    return out;
  }
  function movePalSel(delta){
    if (!palItems.length) return;
    palSel = Math.max(0, Math.min(palItems.length - 1, palSel + delta));
    var items = palResults.querySelectorAll(".pal-item");
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
    syncPalActiveDescendant();
    if (items[palSel]) items[palSel].scrollIntoView({ block: "nearest" });
  }
  function commitPal(source){
    var item = palItems[palSel];
    if (!item) return;
    if (item.type === "command"){
      item.run();
      closePalette();
      return;
    }
    var node = nodes[item.id];
    closePalette();
    if (node) goToNode(node, source);
  }
  function onPaletteClick(e){
    var it = e.target.closest(".pal-item");
    if (!it) return;
    palSel = Number(it.dataset.idx) || 0;
    commitPal(motionSourceFromEvent(e));
  }
  function onPaletteMousemove(e){
    var it = e.target.closest(".pal-item");
    if (!it) return;
    var idx = Number(it.dataset.idx) || 0;
    if (idx !== palSel){ palSel = idx; var items = palResults.querySelectorAll(".pal-item"); for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel); syncPalActiveDescendant(); }
  }
