import { providerFor, settingsForProvider, PROVIDERS } from "../brain/index.js";
import { loadSettings, saveSettings } from "./preferences-store.js";
import { getApiKey } from "./credential-store.js";
import { testedModelHint } from "../brain/tested-models.js";
import { loadModelCatalog, searchModels, formatModelPrice, prettyModelId, SUGGESTED_MODEL_IDS, RECOMMENDED_MODEL_ID } from "../brain/model-catalog.js";
import { escapeHtml } from "../../core/utils.js";
import { openPopover } from "../../ui/primitives/popover.js";
import { fieldMarkup, wireField } from "../../ui/primitives/field.js";
import { selectMarkup, wireSelect } from "../../ui/primitives/select.js";
import { comboboxMarkup, wireCombobox } from "../../ui/primitives/combobox.js";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const chevron = `<svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`;

export function createSettingsPopover(options) {
  const trigger = options.trigger;
  let surface = null;
  let popover = null;
  let providerSelect = null;
  let modelCatalogCache = null;
  let keyToken = 0;

  function applyPatch(patch) {
    const current = loadSettings();
    const merged = { ...current, ...patch };
    const changedProvider = providerFor(merged.preset).id !== providerFor(current.preset).id;
    const apiKey = Object.prototype.hasOwnProperty.call(patch, "api_key") ? patch.api_key : getApiKey(changedProvider ? merged : current);
    saveSettings({ ...merged, api_key: apiKey });
    options.onSettingsChange?.();
  }

  function modelDisplayName(id) {
    return modelCatalogCache?.find((model) => model.id === id)?.name || prettyModelId(id);
  }

  function renderConditionalSections() {
    const host = surface?.querySelector("#settings-conditional-sections");
    if (!host) return;
    const settings = loadSettings();
    const preset = providerFor(settings.preset);
    const currentModel = settings.answer_model || preset.answer_model;
    surface.querySelector("#settings-panel").dataset.preset = preset.id;
    host.innerHTML = `${preset.id === "custom" ? `<div class="settings-section endpoint-section">${fieldMarkup({ id: "provider-base", label: "Endpoint", value: settings.base_url || "", placeholder: "http://localhost:11434/v1", hint: "Use an OpenAI-compatible endpoint. Localhost works directly; remote origins require a self-hosted build." })}</div>` : ""}
      ${preset.model_source === "catalog" ? `<div class="settings-section model-section"><div class="settings-row"><span class="settings-label" id="model-select-label">Model</span>${comboboxMarkup({ id: "model-select", valueId: "model-select-name", labelledBy: "model-select-label", value: currentModel, label: modelDisplayName(currentModel), title: currentModel, iconHtml: chevron })}</div></div>` : `<div class="settings-section model-section local-model-section"><div class="settings-row"><span class="settings-label" id="local-model-label">Model</span>${comboboxMarkup({ id: "local-model", labelledBy: "local-model-label", value: currentModel, label: currentModel, title: currentModel, iconHtml: chevron })}</div><small class="field-hint">Use the exact name shown by <code>ollama list</code>.</small></div>`}
      ${preset.requires_key ? `<div class="settings-section key-section">${fieldMarkup({ id: "api-key", type: "password", label: `${preset.label} key`, value: getApiKey(settings), placeholder: apiKeyPlaceholder(settings.preset), autocomplete: "off", spellcheck: "false", toggleId: "api-key-toggle", toggleHtml: options.eyeSvg(false), labelAfterHtml: preset.id === "openrouter" ? `<a class="key-get" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key →</a>` : "", status: { id: "api-key-status", className: "key-status idle visible", text: keyIdleWhisper(preset) } })}<label class="settings-row remember-row" for="session-only"><span class="switch-copy"><strong>Remember on this device</strong><small>Turn off on shared computers.</small></span><span class="switch" aria-hidden="true"><input id="session-only" type="checkbox" role="switch" ${settings.session_only === false ? "checked" : ""}><span class="switch-track"></span></span></label></div>` : ""}
      <details class="settings-advanced"><summary>Advanced</summary><div class="settings-advanced-grid">${fieldMarkup({ id: "answer-model", label: "Answer model", value: settings.answer_model || "", hint: testedModelHint(settings.answer_model || preset.answer_model), hintClass: "model-hint", hintAttrs: { "data-model-hint": "answer" } })}${fieldMarkup({ id: "author-model", label: "Author model", value: settings.author_model || "", hint: testedModelHint(settings.author_model || preset.author_model), hintClass: "model-hint", hintAttrs: { "data-model-hint": "author" } })}${fieldMarkup({ id: "fetch-proxy-url", label: "Link relay", value: settings.fetch_proxy_url || "", placeholder: "https://your-relay.example/?url=", hint: "When a site blocks in-browser fetching, links open through this relay instead. It sees only the page URL — never your key or your questions." })}</div></details>`;
    wireConditionalSections(host);
    popover?.update();
  }

  function wireConditionalSections(host) {
    wireModelComboboxes(host);
    ["provider-base", "answer-model", "author-model", "fetch-proxy-url"].forEach((id) => wireField(host, { id }));
    wireField(host, { id: "api-key", toggleId: "api-key-toggle", renderToggle: options.eyeSvg });
    const keyInput = host.querySelector("#api-key");
    let timer = 0;
    if (keyInput) {
      keyInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => commitSettingsKey(), 350); });
      keyInput.addEventListener("paste", () => setTimeout(() => commitSettingsKey(), 0));
      keyInput.addEventListener("blur", () => commitSettingsKey());
      keyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commitSettingsKey({ required: true }); } });
      host.querySelector("#session-only")?.addEventListener("change", (event) => applyPatch({ session_only: !event.target.checked }));
    }
    const liveField = (id, key) => host.querySelector(`#${id}`)?.addEventListener("change", (event) => { applyPatch({ [key]: event.target.value.trim() }); updateModelHints(); syncModelSelectLabel(); });
    liveField("provider-base", "base_url"); liveField("answer-model", "answer_model"); liveField("author-model", "author_model"); liveField("fetch-proxy-url", "fetch_proxy_url");
    host.querySelector("#answer-model")?.addEventListener("input", updateModelHints);
    host.querySelector("#author-model")?.addEventListener("input", updateModelHints);
    updateModelHints();
  }

  function wireProviderSelect() {
    const providerOptions = Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label }));
    providerSelect = wireSelect(surface, { id: "provider-select", labelledBy: "provider-select-label", options: providerOptions, onChange: (id) => {
      const current = loadSettings();
      if (!id || id === current.preset) return;
      saveSettings({ ...current, api_key: getApiKey(current) });
      applyPatch(settingsForProvider(id, current));
      renderConditionalSections();
    } });
  }

  function renderCatalogModelRow(model, { current, recommended = false, group = "", itemIndex = -1 } = {}) {
    const selected = model.id === current;
    return `${group ? `<div class="model-group-label">${escapeHtml(group)}</div>` : ""}<button type="button" class="model-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-value="${escapeHtml(model.id)}" data-label="${escapeHtml(model.name)}" data-item-index="${itemIndex}" title="${escapeHtml(model.id)}"><span class="model-check" aria-hidden="true">${selected ? "✓" : ""}</span><span class="model-option-name">${escapeHtml(model.name)}</span>${recommended ? `<span class="model-chip">Recommended</span>` : ""}<span class="model-option-price">${escapeHtml(formatModelPrice(model))}</span></button>`;
  }
  function renderExactModelRow(query) {
    return `<button type="button" class="model-option model-use-custom" role="option" aria-selected="false" data-value="${escapeHtml(query)}" data-label="${escapeHtml(query)}" data-free-text="true" title="${escapeHtml(query)}"><span class="model-check" aria-hidden="true"></span><span class="model-option-name">Use “${escapeHtml(query)}”</span><span class="model-option-price">as-is</span></button>`;
  }
  function wireModelComboboxes(root) {
    const searchIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    const commit = (id) => { if (!id) return; applyPatch({ author_model: id, answer_model: id }); ["answer-model", "author-model"].forEach((field) => { const input = root.querySelector(`#${field}`); if (input) input.value = id; }); updateModelHints(); };
    wireCombobox(root, { id: "model-select", valueId: "model-select-name", labelledBy: "model-select-label", placeholder: "Search every model on OpenRouter…", surfaceClassName: "combobox-surface model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, searchAfterHtml: "<kbd>esc</kbd>", freeText: renderExactModelRow, source: {
      load: () => loadModelCatalog().then((models) => (modelCatalogCache = models)),
      filter: (models, query) => query ? searchModels(models, query).map((model, index) => ({ model, itemIndex: index })) : [...SUGGESTED_MODEL_IDS.map((id) => models.find((model) => model.id === id)).filter(Boolean).map((model, index) => ({ model, itemIndex: models.indexOf(model), group: index === 0 ? "Suggested" : "", recommended: model.id === RECOMMENDED_MODEL_ID })), ...models.map((model, index) => ({ model, itemIndex: index, group: index === 0 ? "All models" : "" }))],
      renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().answer_model, ...entry }), loading: () => `<div class="model-note combobox-loading">Loading models…</div>`, empty: (query) => `<div class="model-note combobox-empty">${query ? "No matching models." : "OpenRouter returned no models."}</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't reach OpenRouter for the model list. ${retry}</div>` }, onChange: commit });
    if (!root.querySelector("#local-model")) return;
    wireCombobox(root, { id: "local-model", labelledBy: "local-model-label", placeholder: "Search installed Ollama models…", surfaceClassName: "combobox-surface local-model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, searchAfterHtml: "<kbd>esc</kbd>", freeText: renderExactModelRow, source: {
      load: async () => { const base = (loadSettings().base_url || "http://localhost:11434/v1").replace(/\/+$/, ""); const response = await fetch(`${base}/models`, { headers: { Accept: "application/json" } }); if (!response.ok) throw new Error(); const json = await response.json(); return (Array.isArray(json?.data) ? json.data : []).filter((model) => model?.id).map((model) => ({ id: String(model.id), name: String(model.name || model.id) })); },
      filter: (models, query) => searchModels(models, query).map((model, itemIndex) => ({ model, itemIndex })), renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().answer_model, itemIndex: entry.itemIndex }), loading: () => `<div class="model-note combobox-loading">Looking for installed models…</div>`, empty: (query) => `<div class="model-note combobox-empty">${query ? "No matching installed models." : "No models are installed yet. Run ollama list to check your local models."}</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't reach the local model endpoint. ${retry}</div>` }, onChange: commit });
  }

  function syncModelSelectLabel() { const settings = loadSettings(); const current = settings.answer_model || providerFor(settings.preset).answer_model; const name = surface?.querySelector("#model-select-name"); if (name) name.textContent = modelDisplayName(current); const select = surface?.querySelector("#model-select"); if (select) select.title = current; }
  function updateModelHints() { ["answer", "author"].forEach((kind) => { const input = surface?.querySelector(`#${kind}-model`); const hint = surface?.querySelector(`[data-model-hint="${kind}"]`); if (input && hint) hint.textContent = testedModelHint(input.value); }); }

  async function commitSettingsKey({ required = false } = {}) {
    const input = surface?.querySelector("#api-key"); const status = surface?.querySelector("#api-key-status");
    if (!input || !status) return false;
    const value = input.value.trim(); const preset = providerFor(loadSettings().preset); const token = ++keyToken;
    if (!value) { if (getApiKey(loadSettings())) { applyPatch({ api_key: "" }); options.setKeyStatus(status, "Key removed.", "hint"); } else options.setKeyStatus(status, keyIdleWhisper(preset), "idle"); return false; }
    const result = await options.validateKey({ key: value, presetId: preset.id, statusEl: status, required, onShake: () => input.classList.add("shake-once") });
    if (token !== keyToken) return false;
    if (result) applyPatch({ api_key: value });
    return result;
  }

  function open({ focusKey = false, focusSelector = "" } = {}) {
    if (surface) { const target = focusSelector ? surface.querySelector(focusSelector) : null; target?.focus({ preventScroll: true }); return; }
    const settings = loadSettings(); const preset = providerFor(settings.preset); const providerOptions = Object.values(PROVIDERS).map((provider) => ({ value: provider.id, label: provider.label }));
    surface = document.createElement("div"); surface.id = "web-settings-popover"; surface.className = "web-settings-dialog popover-surface"; surface.tabIndex = -1; surface.setAttribute("aria-label", "Model settings");
    surface.innerHTML = `<div id="settings-inline-key" class="settings-inline-key" hidden></div><section id="settings-panel" class="settings-panel" aria-label="Model settings"><div class="settings-inner"><div class="settings-section provider-section"><div class="settings-row"><span class="settings-label" id="provider-select-label">Provider</span>${selectMarkup({ id: "provider-select", labelledBy: "provider-select-label", value: preset.id, options: providerOptions, iconHtml: chevron })}</div></div><div id="settings-conditional-sections"></div></div></section>`;
    document.body.append(surface); trigger.setAttribute("aria-controls", surface.id); wireProviderSelect(); renderConditionalSections();
    const panel = surface.querySelector("#settings-panel"); if (panel.querySelector("#api-key")?.value.trim()) commitSettingsKey();
    const explicit = focusSelector ? surface.querySelector(focusSelector) : null;
    popover = openPopover({ trigger, surface, placement: "bottom-end", initialFocus: explicit || (focusKey ? surface.querySelector("#api-key") : surface), onClose: close });
  }
  function close() {
    if (!surface) return;
    const old = surface; surface = null; providerSelect?.close({ restoreFocus: false }); providerSelect = null;
    const activePopover = popover; popover = null; activePopover?.close(); old.remove(); trigger.removeAttribute("aria-controls"); trigger.setAttribute("aria-expanded", "false"); options.onClose?.();
  }
  return { open, close, refresh: renderConditionalSections, getInlineKeySlot: () => surface?.querySelector("#settings-inline-key") || null };
}

function keyIdleWhisper(preset) { return `Stored only in this browser, sent directly to ${preset.label}.`; }
export function apiKeyPlaceholder(presetId) { return presetId === "openrouter" ? "sk-or-v1-…" : "API key"; }
