import { providerFor, settingsForProvider, PROVIDERS } from "../brain/index.js";
import { loadSettings, saveSettings } from "./preferences-store.js";
import { getApiKey } from "./credential-store.js";
import { getGenerationSetupStatus, markGenerationSetupComplete } from "./setup-readiness.js";
import { loadModelCatalog, searchModels, formatModelPrice, prettyModelId, SUGGESTED_MODEL_IDS, RECOMMENDED_MODEL_ID } from "../brain/model-catalog.js";
import { discoverLocalModels } from "../brain/local-model-catalog.js";
import { PDF_TRANSCRIPTION_HELP, localVisionModels, pdfTranscriptionCapability } from "../brain/pdf-transcription.js";
import { escapeHtml } from "../../core/utils.js";
import { openPopover } from "../../ui/primitives/popover.js";
import { fieldMarkup, wireField } from "../../ui/primitives/field.js";
import { comboboxMarkup, wireCombobox } from "../../ui/primitives/combobox.js";
import { isCommandEnter } from "../../ui/input-intent.js";
import { iconSvg } from "../../core/html/icons.js";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const chevron = iconSvg("chevron");
const infoIcon = iconSvg("info");

export function createSettingsPopover(options) {
  const defaultTrigger = options.trigger;
  let activeTrigger = defaultTrigger;
  let surface = null;
  let popover = null;
  let modelCatalogCache = null;
  let keyToken = 0;
  let purpose = "settings";
  let readyCallback = null;
  let recoveryStatus = "";
  let scrim = null;
  let localModels = null;
  let localDiscovery = "idle";
  let localDiscoveryMessage = "";
  let localDiscoveryToken = 0;
  let pendingLocalReadyCallback = null;

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

  function localDiscoveryCopy() {
    if (localDiscovery === "loading") return "Looking for installed models…";
    if (localDiscovery === "success") return `${localModels.length} installed model${localModels.length === 1 ? "" : "s"} found.`;
    if (localDiscovery === "empty") return "No installed models were found.";
    if (localDiscovery === "error") return localDiscoveryMessage || "Couldn't reach the local model endpoint.";
    return "Looking for Ollama on this computer…";
  }

  function transcriptionHelpMarkup(preset) {
    const destination = preset.id === "custom"
      ? " Page images stay on your local endpoint."
      : " Page images go to OpenRouter.";
    return `<span class="settings-label-with-info"><span class="settings-label" id="transcribe-model-label">PDF transcription</span><span class="settings-info"><button class="settings-info-trigger" type="button" aria-label="About PDF transcription" aria-describedby="transcribe-model-help">${infoIcon}</button><span class="settings-info-tooltip" id="transcribe-model-help" role="tooltip">${escapeHtml(PDF_TRANSCRIPTION_HELP + destination)}</span></span></span>`;
  }

  function transcriptionStatusCopy(capability) {
    if (capability.status === "checking") return "Checking installed models for vision support…";
    if (capability.available) {
      const count = capability.visionModels?.length || 1;
      return `${count} installed vision model${count === 1 ? "" : "s"} found.`;
    }
    return capability.reason;
  }

  function renderConditionalSections() {
    const host = surface?.querySelector("#settings-conditional-sections");
    if (!host) return;
    const settings = loadSettings();
    const preset = providerFor(settings.preset);
    surface.querySelector("#settings-panel").dataset.preset = preset.id;
    const currentModel = settings.model || preset.model;
    const transcribeModel = settings.transcribe_model || preset.transcribe_model || currentModel;
    const localCapability = preset.id === "custom"
      ? pdfTranscriptionCapability(settings, localDiscovery === "success" || localDiscovery === "empty"
        ? { models: localModels || [] }
        : { models: null, discoveryError: localDiscovery === "error" })
      : pdfTranscriptionCapability(settings);
    const transcribeDisabled = preset.id === "custom" && !localCapability.available;
    const transcribeLabel = transcribeDisabled
      ? (localCapability.status === "checking" ? "Checking…" : "Unavailable")
      : transcribeModel;
    const localModelReady = preset.id !== "custom"
      || (localDiscovery === "success" && !!localModels?.some((model) => model.id === settings.model));
    host.innerHTML = `${recoveryStatus ? `<div class="settings-section settings-recovery" role="status">${escapeHtml(recoveryStatus)}</div>` : ""}
      ${preset.model_source === "catalog" ? `<div class="settings-section model-section"><div class="settings-row"><span class="settings-label" id="model-select-label">Model</span>${comboboxMarkup({ id: "model-select", valueId: "model-select-name", labelledBy: "model-select-label", value: currentModel, label: currentModel, title: currentModel, iconHtml: chevron })}</div></div>` : `<div class="settings-section model-section local-model-section"><div class="settings-row"><span class="settings-label" id="local-model-label">Model</span>${comboboxMarkup({ id: "local-model", labelledBy: "local-model-label", value: currentModel, label: currentModel, title: currentModel, iconHtml: chevron })}</div><small class="field-hint">${escapeHtml(localDiscoveryCopy())}${localDiscovery === "error" || localDiscovery === "empty" ? ` <button id="local-model-setup" class="settings-text-action" type="button">Set up Local</button>` : ""}</small></div>`}
      ${preset.requires_key ? `<div class="settings-section key-section">${fieldMarkup({ id: "api-key", type: "password", label: `${preset.label} key`, value: getApiKey(settings), placeholder: apiKeyPlaceholder(settings.preset), autocomplete: "off", autocapitalize: "none", autocorrect: "off", inputmode: "text", enterkeyhint: "done", spellcheck: "false", toggleId: "api-key-toggle", toggleHtml: options.eyeSvg(false), labelAfterHtml: preset.id === "openrouter" ? `<a class="key-get" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key →</a>` : "", status: { id: "api-key-status", className: "key-status idle visible", text: keyIdleWhisper(preset) } })}<label class="settings-row remember-row" for="session-only"><span class="switch-copy"><strong>Remember on this device</strong><small>Turn off on shared computers.</small></span><span class="switch" aria-hidden="true"><input id="session-only" type="checkbox" role="switch" ${settings.session_only === false ? "checked" : ""}><span class="switch-track"></span></span></label></div>` : ""}
      ${preset.id === "custom" ? `<details class="settings-advanced"><summary>Connection settings</summary><div class="settings-advanced-grid">${fieldMarkup({ id: "provider-base", label: "Endpoint", value: settings.base_url || "", placeholder: "http://localhost:11434/v1", hint: "Use an OpenAI-compatible endpoint." })}</div></details>` : ""}
      <div class="settings-section model-section transcription-model-section"><div class="settings-row">${transcriptionHelpMarkup(preset)}${comboboxMarkup({ id: "transcribe-model", labelledBy: "transcribe-model-label", describedBy: preset.id === "custom" ? "transcribe-model-status" : "", value: transcribeDisabled ? "" : transcribeModel, label: transcribeLabel, title: transcribeDisabled ? localCapability.reason : transcribeModel, iconHtml: chevron, disabled: transcribeDisabled })}</div>${preset.id === "custom" ? `<small id="transcribe-model-status" class="field-hint transcription-status ${escapeHtml(localCapability.status)}">${escapeHtml(transcriptionStatusCopy(localCapability))}${localDiscovery === "success" && !localCapability.available && localCapability.status !== "checking" ? ` <button id="local-vision-retry" class="settings-text-action" type="button">Check again</button>` : ""}</small>` : ""}</div>
      ${purpose !== "settings" || !getGenerationSetupStatus(settings).ready ? `<div class="settings-section settings-complete-section"><button id="complete-model-setup" class="web-primary" type="button"${localModelReady ? "" : " disabled"}>Finish setup</button></div>` : ""}`;
    wireConditionalSections(host);
    popover?.update();
  }

  function wireConditionalSections(host) {
    wireModelComboboxes(host);
    wireField(host, { id: "provider-base" });
    wireField(host, { id: "api-key", toggleId: "api-key-toggle", renderToggle: options.eyeSvg });
    const keyInput = host.querySelector("#api-key");
    let timer = 0;
    if (keyInput) {
      keyInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => commitSettingsKey(), 350); });
      keyInput.addEventListener("paste", () => setTimeout(() => commitSettingsKey(), 0));
      keyInput.addEventListener("blur", () => commitSettingsKey());
      keyInput.addEventListener("keydown", (event) => {
        if (!isCommandEnter(event)) return;
        event.preventDefault();
        void commitSettingsKey({ required: true }).then((valid) => { if (valid) keyInput.blur(); });
      });
      host.querySelector("#session-only")?.addEventListener("change", (event) => applyPatch({ session_only: !event.target.checked }));
    }
    host.querySelector("#provider-base")?.addEventListener("change", (event) => { applyPatch({ base_url: event.target.value.trim() }); void runLocalDiscovery(); });
    host.querySelector("#local-model-setup")?.addEventListener("click", launchOllamaRecovery);
    host.querySelector("#local-vision-retry")?.addEventListener("click", () => void runLocalDiscovery());
    host.querySelector("#complete-model-setup")?.addEventListener("click", () => void completeSetup());
  }

  function wireProviderControl() {
    surface.querySelectorAll("[data-provider]").forEach((button) => button.addEventListener("click", () => {
      const id = button.dataset.provider;
      const current = loadSettings();
      if (!id || id === current.preset) return;
      localDiscoveryToken += 1;
      saveSettings({ ...current, api_key: getApiKey(current) });
      applyPatch(settingsForProvider(id, current));
      surface.querySelectorAll("[data-provider]").forEach((choice) => choice.setAttribute("aria-pressed", choice.dataset.provider === id ? "true" : "false"));
      recoveryStatus = ""; localModels = null; localDiscovery = "idle";
      renderConditionalSections();
      if (id === "custom") void runLocalDiscovery();
    }));
  }

  async function runLocalDiscovery() {
    if (providerFor(loadSettings().preset).id !== "custom") return;
    const token = ++localDiscoveryToken;
    localDiscovery = "loading"; localDiscoveryMessage = ""; renderConditionalSections();
    try {
      const models = await discoverLocalModels(loadSettings().base_url);
      if (token !== localDiscoveryToken) return;
      localModels = models;
      localDiscovery = models.length ? "success" : "empty";
      if (models.length) {
        const settings = loadSettings();
        const patch = {};
        if (!models.some((model) => model.id === settings.model) && !getGenerationSetupStatus(settings).ready) patch.model = models[0].id;
        const visionModels = localVisionModels(models);
        if (visionModels.length && !visionModels.some((model) => model.id === settings.transcribe_model)) {
          patch.transcribe_model = visionModels.find((model) => model.id === (patch.model || settings.model))?.id || visionModels[0].id;
        }
        if (Object.keys(patch).length) applyPatch(patch);
      }
    } catch (error) {
      if (token !== localDiscoveryToken) return;
      localModels = null; localDiscovery = "error";
      localDiscoveryMessage = "";
    }
    renderConditionalSections();
  }

  function launchOllamaRecovery() {
    if (providerFor(loadSettings().preset).id !== "custom") return;
    const recoveryTrigger = activeTrigger;
    pendingLocalReadyCallback = readyCallback || pendingLocalReadyCallback;
    readyCallback = null;
    close();
    options.openOllamaRecovery?.({ settings: loadSettings(), trigger: recoveryTrigger });
  }

  async function completeSetup() {
    const settings = loadSettings(); const preset = providerFor(settings.preset);
    if (!settings.model) return;
    if (preset.requires_key) {
      const ok = await commitSettingsKey({ required: true });
      if (!ok) return;
    } else if (localDiscovery !== "success" || !localModels?.some((model) => model.id === settings.model)) return;
    markGenerationSetupComplete();
    options.onSettingsChange?.();
    const callback = readyCallback; readyCallback = null;
    close();
    await callback?.();
  }

  function renderCatalogModelRow(model, { current, recommended = false, group = "", itemIndex = -1 } = {}) {
    const selected = model.id === current;
    return `${group ? `<div class="model-group-label">${escapeHtml(group)}</div>` : ""}<button type="button" class="model-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-value="${escapeHtml(model.id)}" data-label="${escapeHtml(model.name)}" data-item-index="${itemIndex}" title="${escapeHtml(model.id)}"><span class="model-check" aria-hidden="true">${selected ? "✓" : ""}</span><span class="model-option-name">${escapeHtml(model.name)}</span>${recommended ? `<span class="model-chip">Recommended</span>` : ""}<span class="model-option-price">${escapeHtml(formatModelPrice(model))}</span></button>`;
  }

  function renderExactModelRow(query) {
    return `<button type="button" class="model-option model-use-custom" role="option" aria-selected="false" data-value="${escapeHtml(query)}" data-label="${escapeHtml(query)}" data-free-text="true" title="${escapeHtml(query)}"><span class="model-check" aria-hidden="true"></span><span class="model-option-name">Use “${escapeHtml(query)}”</span><span class="model-option-price">as-is</span></button>`;
  }

  function wireModelComboboxes(root) {
    const searchIcon = iconSvg("search", { size: 13 });
    const commit = (id) => { if (!id) return; applyPatch({ model: id }); };
    wireCombobox(root, { id: "model-select", valueId: "model-select-name", labelledBy: "model-select-label", placeholder: "Search every model on OpenRouter…", surfaceClassName: "combobox-surface model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, searchAfterHtml: "<kbd>esc</kbd>", freeText: renderExactModelRow, source: {
      load: () => loadModelCatalog().then((models) => (modelCatalogCache = models)),
      filter: (models, query) => query ? searchModels(models, query).map((model, index) => ({ model, itemIndex: index })) : [...SUGGESTED_MODEL_IDS.map((id) => models.find((model) => model.id === id)).filter(Boolean).map((model, index) => ({ model, itemIndex: models.indexOf(model), group: index === 0 ? "Suggested" : "", recommended: model.id === RECOMMENDED_MODEL_ID })), ...models.map((model, index) => ({ model, itemIndex: index, group: index === 0 ? "All models" : "" }))],
      renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().model, ...entry }), loading: () => `<div class="model-note combobox-loading">Loading models…</div>`, empty: (query) => `<div class="model-note combobox-empty">${query ? "No matching models." : "OpenRouter returned no models."}</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't reach OpenRouter for the model list. ${retry}</div>` }, onChange: commit });
    const preset = providerFor(loadSettings().preset);
    if (preset.id === "custom") {
      wireCombobox(root, { id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Search installed vision models…", surfaceClassName: "combobox-surface local-model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, source: {
        load: async () => localVisionModels(localModels || await discoverLocalModels(loadSettings().base_url)), filter: (models, query) => searchModels(models, query).map((model, itemIndex) => ({ model, itemIndex })),
        renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().transcribe_model, itemIndex: entry.itemIndex }), loading: () => `<div class="model-note combobox-loading">Checking installed vision models…</div>`, empty: () => `<div class="model-note combobox-empty">No installed vision models.</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't verify local vision models. ${retry}</div>` }, onChange: (id) => { if (id) applyPatch({ transcribe_model: id }); } });
    } else {
      wireCombobox(root, { id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Choose a PDF transcription model…", surfaceClassName: "combobox-surface model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, freeText: renderExactModelRow, source: {
        load: () => loadModelCatalog().then((models) => (modelCatalogCache = models)), filter: (models, query) => searchModels(models, query).map((model, itemIndex) => ({ model, itemIndex })),
        renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().transcribe_model, itemIndex: entry.itemIndex }), loading: () => `<div class="model-note combobox-loading">Loading models…</div>`, empty: () => `<div class="model-note combobox-empty">No matching models.</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't load models. ${retry}</div>` }, onChange: (id) => { if (id) applyPatch({ transcribe_model: id }); } });
    }
    if (!root.querySelector("#local-model")) return;
    wireCombobox(root, { id: "local-model", labelledBy: "local-model-label", placeholder: "Search installed Ollama models…", surfaceClassName: "combobox-surface local-model-combobox-surface popover-surface", listClassName: "combobox-list model-list", searchIconHtml: searchIcon, searchAfterHtml: "<kbd>esc</kbd>", freeText: renderExactModelRow, source: {
      load: async () => localModels || discoverLocalModels(loadSettings().base_url),
      filter: (models, query) => searchModels(models, query).map((model, itemIndex) => ({ model, itemIndex })), renderOption: (entry) => renderCatalogModelRow(entry.model, { current: loadSettings().model, itemIndex: entry.itemIndex }), loading: () => `<div class="model-note combobox-loading">Looking for installed models…</div>`, empty: (query) => `<div class="model-note combobox-empty">${query ? "No matching installed models." : "No models are installed yet."}</div>`, error: (retry) => `<div class="model-note combobox-error">Couldn't reach the local model endpoint. ${retry}</div>` }, onChange: commit });
  }

  async function commitSettingsKey({ required = false } = {}) {
    const input = surface?.querySelector("#api-key"); const status = surface?.querySelector("#api-key-status");
    if (!input || !status) return false;
    const value = input.value.trim(); const preset = providerFor(loadSettings().preset); const token = ++keyToken;
    if (!value) { if (getApiKey(loadSettings())) { applyPatch({ api_key: "" }); options.setKeyStatus(status, "Key removed.", "hint"); } else options.setKeyStatus(status, required ? "Enter a key first." : keyIdleWhisper(preset), required ? "invalid" : "idle"); return false; }
    const result = await options.validateKey({ key: value, presetId: preset.id, statusEl: status, required, onShake: () => input.classList.add("shake-once") });
    if (token !== keyToken) return false;
    if (result) applyPatch({ api_key: value });
    return result;
  }

  function open({ focusKey = false, focusSelector = "", trigger = defaultTrigger, purpose: nextPurpose = "settings", status = "", onReady = null } = {}) {
    if (surface) { const target = focusSelector ? surface.querySelector(focusSelector) : null; target?.focus({ preventScroll: true }); return; }
    activeTrigger = trigger || defaultTrigger; purpose = nextPurpose; readyCallback = onReady; recoveryStatus = status;
    let settings = loadSettings();
    if (purpose === "setup" && !getGenerationSetupStatus(settings).ready) {
      localDiscoveryToken += 1;
      localModels = null; localDiscovery = "idle"; localDiscoveryMessage = "";
      if (providerFor(settings.preset).id !== "openrouter") {
        applyPatch(settingsForProvider("openrouter", settings));
        settings = loadSettings();
      }
    }
    const preset = providerFor(settings.preset);
    surface = document.createElement("div"); surface.id = "web-settings-popover"; surface.className = "web-settings-dialog popover-surface"; surface.tabIndex = -1; surface.setAttribute("aria-label", "Model settings");
    const title = purpose === "recovery" ? "Reconnect AI" : purpose === "setup" ? "Set up AI" : "Model settings";
    surface.innerHTML = `<section id="settings-panel" class="settings-panel" aria-labelledby="settings-title"><header class="settings-header"><h2 id="settings-title">${title}</h2></header><div class="settings-inner"><div class="settings-section provider-section"><span class="settings-label" id="provider-choice-label">Provider</span><div class="provider-choice" role="group" aria-labelledby="provider-choice-label">${Object.values(PROVIDERS).map((provider) => `<button type="button" data-provider="${provider.id}" aria-pressed="${provider.id === preset.id}">${escapeHtml(provider.label)}</button>`).join("")}</div></div><div id="settings-conditional-sections"></div></div></section>`;
    document.body.append(surface); activeTrigger.setAttribute("aria-controls", surface.id); wireProviderControl(); renderConditionalSections();
    if (activeTrigger?.id === "blank-start-setup") {
      surface.classList.add("settings-setup-surface");
      scrim = document.createElement("div");
      scrim.className = "settings-scrim";
      document.body.append(scrim);
    }
    const panel = surface.querySelector("#settings-panel"); if (panel.querySelector("#api-key")?.value.trim()) commitSettingsKey();
    const explicit = focusSelector ? surface.querySelector(focusSelector) : null;
    const placement = activeTrigger?.id === "blank-start-setup" ? "center" : "bottom-end";
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
    popover = openPopover({ trigger: activeTrigger, surface, placement, initialFocus: explicit || (focusKey && !coarsePointer ? surface.querySelector("#api-key") : surface), onClose: close });
    // Discovery failures stay in Local settings. The guided dialog opens only
    // from the explicit Set up Local action rendered for error/empty states.
    if (preset.id === "custom") void runLocalDiscovery();
  }

  function close() {
    if (!surface) return;
    const old = surface; surface = null;
    scrim?.remove(); scrim = null;
    const activePopover = popover; popover = null; activePopover?.close(); old.remove();
    activeTrigger?.removeAttribute("aria-controls"); activeTrigger?.setAttribute("aria-expanded", "false");
    readyCallback = null; options.onClose?.();
  }

  function completeLocalSetup() {
    markGenerationSetupComplete();
    options.onSettingsChange?.();
    const callback = pendingLocalReadyCallback || readyCallback;
    pendingLocalReadyCallback = null; readyCallback = null;
    void callback?.();
  }

  return { open, close, completeLocalSetup, isOpen: () => !!surface };
}

function keyIdleWhisper(preset) { return `Stored only in this browser, sent directly to ${preset.label}.`; }
function apiKeyPlaceholder(presetId) { return presetId === "openrouter" ? "sk-or-v1-…" : "API key"; }
