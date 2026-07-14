import { escapeHtml } from "../../core/utils.js";
import { isCommandEnter } from "../input-intent.js";
import { openPopover } from "./popover.js";

export function comboboxMarkup(options) {
  var valueId = options.valueId || options.id + "-value";
  return '<button id="' + escapeHtml(options.id) + '" class="' + escapeHtml(options.className || "settings-select") + '" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="' + escapeHtml(options.labelledBy + " " + valueId) + '" data-value="' + escapeHtml(options.value || "") + '"' + (options.title ? ' title="' + escapeHtml(options.title) + '"' : "") + (options.disabled ? " disabled" : "") + (options.describedBy ? ' aria-describedby="' + escapeHtml(options.describedBy) + '"' : "") + '>' +
    '<span id="' + escapeHtml(valueId) + '">' + escapeHtml(options.label || options.value || "") + "</span>" + (options.iconHtml || "") + "</button>";
}

export function wireCombobox(root, options) {
  var trigger = root?.querySelector("#" + options.id), surface = null, input = null, list = null, popover = null;
  var items = [], activeIndex = -1, loadToken = 0, settleTimer = 0, state = "idle";
  if (!trigger) return { trigger: null, close: function() {} };

  function optionRows() { return Array.from(list?.querySelectorAll('[role="option"]') || []); }
  function setActive(index) {
    var rows = optionRows();
    if (!rows.length) { activeIndex = -1; input?.removeAttribute("aria-activedescendant"); return; }
    activeIndex = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach(function(row, rowIndex) { row.classList.toggle("active", rowIndex === activeIndex); });
    rows[activeIndex].scrollIntoView({ block: "nearest" });
    input?.setAttribute("aria-activedescendant", rows[activeIndex].id);
  }
  function prepareOptions() {
    optionRows().forEach(function(row, index) {
      row.id = row.id || options.id + "-option-" + index;
      row.dataset.index = String(index);
      row.tabIndex = -1;
    });
  }
  function freeTextHtml(query) {
    return query && options.freeText ? options.freeText(query, { value: query }) : "";
  }
  function renderResults() {
    if (!surface) return;
    state = "ready";
    var query = input.value.trim();
    var filtered = options.source.filter(items, query);
    var html = filtered.map(function(item, index) {
      return options.source.renderOption(item, { index: index, query: query, value: options.getValue ? options.getValue(item) : item.value });
    }).join("");
    if (!filtered.length) html = freeTextHtml(query) + options.source.empty(query);
    list.innerHTML = html;
    list.scrollTop = 0;
    prepareOptions();
    setActive(optionRows().length ? 0 : -1);
    popover?.update();
  }
  function renderLoading() {
    state = "loading";
    list.innerHTML = options.source.loading();
    setActive(-1); popover?.update();
  }
  function renderError() {
    state = "error";
    var query = input.value.trim();
    var retry = '<button type="button" class="combobox-retry" data-combobox-retry>Try again</button>';
    list.innerHTML = freeTextHtml(query) + options.source.error(retry);
    prepareOptions(); setActive(optionRows().length ? 0 : -1); popover?.update();
  }
  function load() {
    var token = ++loadToken;
    renderLoading();
    Promise.resolve().then(function() { return options.source.load(); }).then(function(loaded) {
      if (!surface || token !== loadToken) return;
      items = Array.isArray(loaded) ? loaded : [];
      renderResults();
    }).catch(function() { if (surface && token === loadToken) renderError(); });
  }
  function close(settings) {
    if (!surface) return;
    var oldSurface = surface;
    surface = null; input?.setAttribute("aria-expanded", "false");
    window.clearTimeout(settleTimer); ++loadToken;
    popover?.close(settings); popover = null;
    oldSurface.remove(); input = null; list = null; items = []; activeIndex = -1;
  }
  function commit(row) {
    if (!row) return;
    var value = row.dataset.value || row.dataset.id || "";
    var itemIndex = Number(row.dataset.itemIndex);
    var item = Number.isInteger(itemIndex) ? items[itemIndex] : null;
    var label = row.dataset.label || row.querySelector(options.optionLabelSelector || ".model-option-name")?.textContent?.trim() || value;
    trigger.dataset.value = value;
    trigger.querySelector("#" + (options.valueId || options.id + "-value")).textContent = label;
    trigger.title = value;
    close();
    options.onChange?.(value, item, { label: label, freeText: row.dataset.freeText === "true" });
  }
  function open() {
    if (surface) return;
    var listboxId = options.id + "-listbox", inputId = options.id + "-input";
    surface = document.createElement("div");
    surface.className = options.surfaceClassName || "combobox-surface popover-surface";
    surface.innerHTML = '<div class="combobox-search-wrap">' + (options.searchIconHtml || "") + '<input id="' + escapeHtml(inputId) + '" placeholder="' + escapeHtml(options.placeholder || "Search…") + '" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="' + escapeHtml(listboxId) + '" aria-labelledby="' + escapeHtml(options.labelledBy) + '">' + (options.searchAfterHtml || "") + '</div><div id="' + escapeHtml(listboxId) + '" class="' + escapeHtml(options.listClassName || "combobox-list") + '" role="listbox" aria-labelledby="' + escapeHtml(options.labelledBy) + '"></div>';
    document.body.appendChild(surface);
    input = surface.querySelector("#" + inputId); list = surface.querySelector("#" + listboxId);
    trigger.setAttribute("aria-controls", listboxId);
    input.addEventListener("input", function() { state === "error" ? renderError() : state === "ready" ? renderResults() : null; });
    input.addEventListener("keydown", function(event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (isCommandEnter(event)) {
        var rows = optionRows();
        if (rows.length) { event.preventDefault(); commit(rows[Math.max(0, activeIndex)]); }
      }
    });
    surface.addEventListener("click", function(event) {
      if (event.target.closest("[data-combobox-retry]")) { load(); return; }
      var row = event.target.closest('[role="option"]'); if (row) commit(row);
    });
    popover = openPopover({ trigger: trigger, surface: surface, placement: options.placement || "bottom-end", initialFocus: input,
      onClose: function() { close(); } });
    load();
    settleTimer = window.setTimeout(function() { popover?.update(); }, 180);
  }

  trigger.addEventListener("keydown", function(event) {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault(); open();
  });
  trigger.addEventListener("click", function() { surface ? close() : open(); });
  return { trigger: trigger, close: close };
}
