import { escapeHtml } from "../../core/utils.js";

function attrs(values) {
  return Object.entries(values).filter(function(entry) { return entry[1] !== undefined && entry[1] !== false; }).map(function(entry) {
    return " " + escapeHtml(entry[0]) + (entry[1] === true ? "" : '="' + escapeHtml(entry[1]) + '"');
  }).join("");
}

export function fieldMarkup(options) {
  var hintId = (options.hint || options.hintHtml) ? options.id + "-hint" : "";
  var statusId = options.status ? (options.status.id || options.id + "-status") : "";
  var describedBy = [hintId, statusId, options.describedBy].filter(Boolean).join(" ");
  var input = '<input' + attrs({
    id: options.id,
    type: options.type || "text",
    value: options.value || "",
    placeholder: options.placeholder,
    autocomplete: options.autocomplete,
    autocapitalize: options.autocapitalize,
    autocorrect: options.autocorrect,
    inputmode: options.inputmode,
    enterkeyhint: options.enterkeyhint,
    spellcheck: options.spellcheck,
    "aria-describedby": describedBy || undefined
  }) + ">";
  var hint = hintId ? '<small id="' + escapeHtml(hintId) + '" class="' + escapeHtml(options.hintClass || "field-hint") + '"' + attrs(options.hintAttrs || {}) + ">" + (options.hintHtml || escapeHtml(options.hint)) + "</small>" : "";
  var status = options.status ? '<div id="' + escapeHtml(statusId) + '" class="' + escapeHtml(options.status.className || "") + '" aria-live="polite">' + escapeHtml(options.status.text || "") + "</div>" : "";

  if (options.type === "password") {
    return '<div class="field field-password">' +
      '<div class="settings-row key-row"><label class="settings-label" for="' + escapeHtml(options.id) + '">' + escapeHtml(options.label) + "</label>" + (options.labelAfterHtml || "") + "</div>" +
      '<div class="key-input-wrap">' + input + '<button id="' + escapeHtml(options.toggleId) + '" type="button" aria-label="Show key" aria-pressed="false">' + (options.toggleHtml || "") + "</button></div>" + status + hint + "</div>";
  }

  return '<label class="field" for="' + escapeHtml(options.id) + '"><span>' + escapeHtml(options.label) + "</span>" + input + hint + status + "</label>";
}

export function wireField(root, options) {
  var input = root?.querySelector("#" + options.id);
  var toggle = options.toggleId ? root?.querySelector("#" + options.toggleId) : null;
  var field = input?.closest(".field");
  input?.addEventListener("pointerdown", function() { field?.classList.add("field-pointer-focus"); });
  input?.addEventListener("keydown", function() { field?.classList.remove("field-pointer-focus"); });
  input?.addEventListener("blur", function() { field?.classList.remove("field-pointer-focus"); });
  if (input && toggle) toggle.addEventListener("click", function() {
    var visible = input.type === "text";
    input.type = visible ? "password" : "text";
    toggle.setAttribute("aria-label", visible ? "Show key" : "Hide key");
    toggle.setAttribute("aria-pressed", visible ? "false" : "true");
    if (options.renderToggle) toggle.innerHTML = options.renderToggle(!visible);
  });
  return { input: input, toggle: toggle };
}
