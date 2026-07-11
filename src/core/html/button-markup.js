import { escapeHtml } from "../utils.js";

const STATEFUL_ARIA = ["aria-haspopup", "aria-controls", "aria-expanded", "aria-pressed"];

function attribute(name, value) {
  if (value === undefined || value === false || value === null) return "";
  return " " + name + (value === true ? "" : '="' + escapeHtml(String(value)) + '"');
}

function buttonAttributes(options, iconOnly) {
  const label = String(options.label || "").trim();
  const ariaLabel = String(options.ariaLabel || "").trim();
  if (iconOnly && !ariaLabel) throw new Error("IconButton requires aria-label");
  if (!iconOnly && !label && !ariaLabel) throw new Error("Button requires an accessible name");

  const baseClass = options.bare ? "" : (iconOnly ? "tool-btn tool-icon" : "tool-btn");
  const className = [baseClass, options.className].filter(Boolean).join(" ");
  let result = attribute("class", className || undefined) +
    attribute("id", options.id) +
    attribute("type", "button") +
    attribute("role", options.role) +
    attribute("tabindex", options.tabIndex) +
    attribute("title", options.title) +
    attribute("aria-label", ariaLabel || undefined);
  for (const [name, value] of Object.entries(options.dataAttrs || {})) {
    const attrName = "data-" + String(name).replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    result += attribute(attrName, value);
  }
  for (const name of STATEFUL_ARIA) {
    const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result += attribute(name, options[name] ?? options[camelName]);
  }
  const aria = options.aria || {};
  for (const [name, value] of Object.entries(aria)) {
    const attrName = name.startsWith("aria-") ? name : "aria-" + name;
    if (!STATEFUL_ARIA.includes(attrName) && attrName !== "aria-label") result += attribute(attrName, value);
  }
  return result + attribute("hidden", options.hidden) + attribute("disabled", options.disabled);
}

export function buttonMarkup(options = {}) {
  const content = (options.svgIconHtml || "") + escapeHtml(String(options.label || "")) +
    (options.kbdHint ? "<kbd>" + escapeHtml(String(options.kbdHint)) + "</kbd>" : "");
  return "<button" + buttonAttributes(options, false) + ">" + content + "</button>";
}

export function iconButtonMarkup(options = {}) {
  const content = options.svgIconHtml || escapeHtml(String(options.icon || ""));
  return "<button" + buttonAttributes(options, true) + ">" + content + "</button>";
}
