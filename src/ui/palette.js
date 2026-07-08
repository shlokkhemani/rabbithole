import {
  esc,
  goToNode,
  isUnread,
  lensBadgeHtml,
  mode,
  motionSourceFromEvent,
  nodes,
  palResults,
  palText,
  paletteEl,
  truncate
} from "./core.js";
import { frameAll, tidy } from "./canvas-view.js";
import { activateFocusTrap } from "./focus-trap.js";

var paletteHooks = {
  hideAsk: function(){},
  hidePeek: function(){},
  closeShare: function(){},
  hideConfirm: function(){}
};

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
  var palOpen = false, palSel = 0, palItems = [], palCanvasCommands = false, palTrap = null;
export function initPalette(){
  paletteEl.addEventListener("mousedown", function(e){ if (e.target === paletteEl) closePalette(); });
  palText.addEventListener("input", function(){ renderPalette(palText.value); });
  palText.addEventListener("keydown", onPaletteKeydown);
  palResults.addEventListener("click", onPaletteClick);
  palResults.addEventListener("mousemove", onPaletteMousemove);
}

export function togglePalette(){ if (palOpen) closePalette(); else openPalette(); }
export function openPalette(){
    palOpen = true;
    palCanvasCommands = mode === "canvas";
    paletteHooks.hideAsk(); paletteHooks.hidePeek(); paletteHooks.closeShare(); paletteHooks.hideConfirm();
    paletteEl.classList.add("visible");
    palText.value = "";
    renderPalette("");
    if (palTrap) palTrap();
    palTrap = activateFocusTrap(paletteEl, { initialFocus: palText, onEscape: closePalette });
  }
export function closePalette(){
    palOpen = false;
    palCanvasCommands = false;
    paletteEl.classList.remove("visible");
    if (palTrap){ palTrap(); palTrap = null; }
    palText.blur();
  }
  function onPaletteKeydown(e){
    if (e.key === "Escape"){ e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown"){ e.preventDefault(); movePalSel(1); }
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
      palResults.innerHTML = tokens.length ? '<div class="pal-empty">Nothing in this hole matches that.</div>' : "";
      return;
    }
    var html = "";
    palItems.forEach(function(item, i){
      if (item.type === "command"){
        html += '<div class="pal-item pal-command' + (i === palSel ? " sel" : "") + '" data-idx="' + i + '">';
        html += '<div class="pal-t"><span class="pal-title">' + esc(item.name) + '</span><kbd class="pal-kbd">' + esc(item.kbd) + '</kbd></div>';
        html += '</div>';
        return;
      }
      var n = nodes[item.id];
      if (!n) return;
      var badge = (n.origin && n.origin.synthesis) ? '<span class="lens-badge">✦ Synthesis</span>'
        : (n.origin && n.origin.lens) ? lensBadgeHtml(n.origin.lens) : "";
      var flags = (n.status === "pending") ? '<span class="pal-writing">writing…</span>' : (isUnread(n) ? '<span class="pal-dot"></span>' : "");
      html += '<div class="pal-item' + (i === palSel ? " sel" : "") + '" data-idx="' + i + '">';
      html += '<div class="pal-t">' + flags + '<span class="pal-title">' + esc(n.title || "Untitled") + '</span>' + badge + '</div>';
      html += '<div class="pal-s">' + palSnippet(n, tokens) + '</div>';
      html += '</div>';
    });
    palResults.innerHTML = html;
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
    return esc(truncate(body, 100));
  }
  // Escape text while wrapping every token match in <mark>.
  function hiTokens(text, tokens){
    if (!tokens.length) return esc(text);
    var lower = text.toLowerCase(), out = "", i = 0;
    while (i < text.length){
      var best = -1, bl = 0;
      for (var t = 0; t < tokens.length; t++){
        var at = lower.indexOf(tokens[t], i);
        if (at !== -1 && (best === -1 || at < best)){ best = at; bl = tokens[t].length; }
      }
      if (best === -1){ out += esc(text.slice(i)); break; }
      out += esc(text.slice(i, best)) + "<mark>" + esc(text.slice(best, best + bl)) + "</mark>";
      i = best + bl;
    }
    return out;
  }
  function movePalSel(delta){
    if (!palItems.length) return;
    palSel = Math.max(0, Math.min(palItems.length - 1, palSel + delta));
    var items = palResults.querySelectorAll(".pal-item");
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
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
    if (idx !== palSel){ palSel = idx; var items = palResults.querySelectorAll(".pal-item"); for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel); }
  }
