import { providerFor, settingsForProvider, PROVIDERS } from "../provider/provider-registry.js";
import { loadSettings, saveSettings } from "./settings.js";
import { getApiKey } from "./credential-store.js";
import { setKeyStatus, validateKeyForPreset } from "./key-validation.js";
import { getGenerationSetupStatus, markGenerationSetupComplete } from "./setup-readiness.js";
import { loadModelCatalog, searchModels, formatModelPrice, prettyModelId, SUGGESTED_MODEL_IDS, RECOMMENDED_MODEL_ID } from "../provider/model-catalog.js";
import { discoverLocalModels } from "../provider/local-model-catalog.js";
import { addressSpaceOf, fetchOpenAICompatibleModels, isHttpUrl } from "../provider/model-endpoint.js";
import { PDF_TRANSCRIPTION_HELP, localVisionModels, pdfTranscriptionCapability } from "../provider/pdf-transcription.js";
import {
  BRIDGE_AGENT_LABELS,
  BRIDGE_COMMAND,
  BRIDGE_DOWN_HEADING,
  BRIDGE_PING_INTERVAL_MS,
  bridgeAgent,
  bridgeAgentOf,
  bridgeModelsForAgent,
  bridgeStateKey,
  consumeBridgeEvents,
  nextBridgeReconnectDelay,
  pairingFromInput,
  pingBridge,
  planLabel,
  reasoningLabel,
} from "../provider/bridge-catalog.js";
import { escapeHtml } from "../../core/utils.js";
import { closeSettingsSheet, openSettingsSheet } from "../../ui/settings-sheet.js";
import { fieldMarkup, wireField } from "../../ui/primitives/field.js";
import { comboboxMarkup, wireCombobox } from "../../ui/primitives/combobox.js";
import { isCommandEnter } from "../../ui/input-intent.js";
import { iconSvg } from "../../core/html/icons.js";
import { createBridgeConnection } from "./bridge-connection.js";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
/* One line under the endpoint field: what to type, replaced by what happened. */
const ENDPOINT_HINT = "OpenAI-compatible base URL.";
const chevron = iconSvg("chevron");
const infoIcon = iconSvg("info");
const searchIcon = iconSvg("search", { size: 13 });

/*
 * The five leaf choices a user can actually make, flattened into one exclusive
 * list. Claude Code and Codex share the `subscriptions` preset (one bridge,
 * one transport) but are separate identities to the user, so they are separate
 * rows; the row — not a nested switch — carries the agent choice.
 */
const PROVIDER_ROWS = Object.freeze([
  Object.freeze({ id: "openrouter", preset: "openrouter", label: "OpenRouter", detail: "Hundreds of models · your API key" }),
  Object.freeze({ id: "claude", preset: "subscriptions", agent: "claude", label: "Claude Code", detail: "Your Claude plan" }),
  Object.freeze({ id: "codex", preset: "subscriptions", agent: "codex", label: "Codex", detail: "Your ChatGPT plan" }),
  Object.freeze({ id: "local", preset: "local", label: "Ollama", detail: "Models on this computer" }),
  Object.freeze({ id: "custom_endpoint", preset: "custom_endpoint", label: "Custom endpoint", detail: "Any OpenAI-compatible server" }),
]);

function providerRowMarkup(row, selected) {
  return `<div class="provider-item${selected ? " selected" : ""}" data-provider-item="${row.id}"><${BUTTON_TAG} type="button" class="provider-row" role="radio" data-provider="${row.id}" aria-checked="${selected}" tabindex="${selected ? 0 : -1}"><span class="provider-dot" aria-hidden="true"></span><span class="provider-copy"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.detail)}</small></span><span class="provider-chip" data-provider-chip hidden></span></button><div class="provider-body"><div class="provider-body-slot"></div></div></div>`;
}

function eyeSvg(open) {
  return iconSvg(open ? "eye-off" : "eye");
}

/** @param {{trigger?: HTMLElement | null, onSettingsChange?: () => void, openOllamaRecovery?: (options: any) => void}} [options] */
export function createModelSettings({
  trigger: defaultTrigger,
  onSettingsChange = () => {},
  openOllamaRecovery = () => {}
} = {}) {
  let activeTrigger = defaultTrigger;
  let surface = null;
  let modelCatalogCache = null;
  let keyToken = 0;
  let purpose = "settings";
  let readyCallback = null;
  let recoveryStatus = "";
  let localModels = null;
  let localDiscovery = "idle";
  let localDiscoveryMessage = "";
  let localDiscoveryToken = 0;
  let pendingLocalReadyCallback = null;
  let endpointModels = null;
  let endpointDiscovery = "idle";
  let endpointDiscoveryMessage = "";
  let endpointDiscoveryToken = 0;
  let bridgeState = null;
  let bridgeView = "idle";
  let lastBridgeFrameKey = "";
  let lastBridgeRenderKey = "";
  let bridgeRecoveryAgent = "";
  let bridgeUnauthorized = false;
  let pairingSetupPending = false;
  let pairingSetupComplete = null;
  let conditionalComboboxes = [];
  let openrouterKeyValid = false;
  let lastKeyCommit = { value: null, result: false };
  const bridgeConnection = createBridgeConnection({
    loadSettings,
    isSubscription: (settings) => providerFor(settings.preset).id === "subscriptions",
    consumeEvents: consumeBridgeEvents,
    ping: pingBridge,
    nextDelay: nextBridgeReconnectDelay,
    pingInterval: BRIDGE_PING_INTERVAL_MS,
    probeWanted: () => !!surface
      && providerFor(loadSettings().preset).id === "subscriptions"
      && (bridgeView === "re_pair" || bridgeView === "bridge_down" || bridgeView === "idle"),
    reconnectFromProbe: () => bridgeView !== "re_pair",
    onState: acceptBridgeState,
    onView: setBridgeView,
    onDisconnected: () => {
      bridgeState = null;
      lastBridgeFrameKey = "";
    },
    onUnauthorized: () => {
      bridgeState = null;
      lastBridgeFrameKey = "";
      bridgeUnauthorized = true;
      lastBridgeRenderKey = "";
    },
    onProbeChange: () => {
      lastBridgeRenderKey = "";
      renderConditionalSections();
    },
  });

  function applyPatch(patch) {
    const current = loadSettings();
    const merged = { ...current, ...patch };
    const changedProvider = providerFor(merged.preset).id !== providerFor(current.preset).id;
    const apiKey = Object.prototype.hasOwnProperty.call(patch, "api_key") ? patch.api_key : getApiKey(changedProvider ? merged : current);
    saveSettings({ ...merged, api_key: apiKey });
    onSettingsChange();
  }

  function loadCatalog() {
    return loadModelCatalog().then((models) => (modelCatalogCache = models));
  }

  function localDiscoveryCopy() {
    if (localDiscovery === "loading") return "Looking for installed models…";
    if (localDiscovery === "success") return `${localModels.length} installed model${localModels.length === 1 ? "" : "s"} found.`;
    if (localDiscovery === "empty") return "No installed models were found.";
    if (localDiscovery === "error") return localDiscoveryMessage || "Couldn't reach the local model endpoint.";
    return "Looking for Ollama on this computer…";
  }

  function transcriptionHelpMarkup(preset, agentId = "") {
    const destination = preset.id === "local"
      ? " Page images stay on your local endpoint."
      : preset.id === "custom_endpoint"
        ? " Page images go to your custom endpoint."
        : preset.id === "subscriptions"
          ? ` Page images go through ${BRIDGE_AGENT_LABELS[agentId] || "your selected agent"} on this computer.`
          : " Page images go to OpenRouter.";
    return `<span class="settings-label-with-info"><span class="settings-label" id="transcribe-model-label">PDF transcription</span><span class="settings-info"><${BUTTON_TAG} class="settings-info-trigger" type="button" aria-label="About PDF transcription" aria-describedby="transcribe-model-help">${infoIcon}</button><span class="settings-info-tooltip" id="transcribe-model-help" role="tooltip">${escapeHtml(PDF_TRANSCRIPTION_HELP + destination)}</span></span></span>`;
  }

  function transcriptionStatusCopy(capability) {
    if (capability.status === "checking") return "Checking installed models for vision support…";
    if (capability.available) {
      const count = capability.visionModels?.length || 1;
      return `${count} installed vision model${count === 1 ? "" : "s"} found.`;
    }
    return capability.reason;
  }

  /*
   * These fields commit on blur, so the one holding focus is the only place text can exist
   * that settings has not seen yet — a key is 350ms of debounce away from being saved. A
   * repaint renders saved settings, and the endpoint's verdict on a keyless probe routinely
   * arrives mid-word, so without carrying that text across the repaint it gets painted over
   * with the saved value and silently discarded.
   */
  function textBeingTyped(host) {
    const el = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    if (!el || el.tagName !== "INPUT" || el.type === "checkbox" || !host.contains(el)) return null;
    return { id: el.id, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  }

  function restoreTextBeingTyped(host, typed) {
    const el = typed?.id ? host.querySelector(`#${typed.id}`) : null;
    if (!el) return;
    el.value = typed.value;
    el.focus({ preventScroll: true });
    if (typed.start !== null) el.setSelectionRange(typed.start, typed.end);
  }

  function focusedControlKey(host) {
    let element = document.activeElement;
    if (!host.contains(element)) {
      element = conditionalComboboxes.find((controller) => controller.trigger?.getAttribute("aria-expanded") === "true")?.trigger;
    }
    if (!element) return null;
    if (element.id) return { kind: "id", value: element.id };
    if (element instanceof HTMLElement && element.dataset?.reasoning) return { kind: "reasoning", value: element.dataset.reasoning };
    return null;
  }

  function disposeConditionalComboboxes() {
    for (const controller of conditionalComboboxes.splice(0)) controller.close({ restoreFocus: false });
  }

  function restoreTransitionFocus(host, key) {
    let target = null;
    if (key?.kind === "id") target = host.querySelector(`#${key.value}`);
    if (key?.kind === "reasoning") {
      target = [...host.querySelectorAll("[data-reasoning]")].find((element) => element.dataset.reasoning === key.value);
    }
    target ||= host.querySelector("[data-state-action]");
    target?.focus({ preventScroll: true });
  }

  function setConditionalHtml(host, html, { morph = false } = {}) {
    const focused = focusedControlKey(host);
    const previousHeight = morph ? host.offsetHeight : 0;
    disposeConditionalComboboxes();
    host.innerHTML = html;
    if (previousHeight > 0 && typeof host.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      const nextHeight = host.offsetHeight;
      if (nextHeight > 0 && nextHeight !== previousHeight) {
        host.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          { duration: 200, easing: "cubic-bezier(.23, 1, .32, 1)" },
        );
      }
    }
    return focused;
  }

  function setSubscriptionHtml(host, html) {
    const focused = setConditionalHtml(host, html, { morph: true });
    wireConditionalSections(host);
    restoreTransitionFocus(host, focused);
  }

  function renderSubscriptionsSections(host, settings) {
    syncBridgeProbe();
    const recovery = recoveryStatus
      ? `<div class="settings-section settings-recovery" role="status">${escapeHtml(recoveryStatus)}</div>`
      : "";
    const agentId = selectedBridgeAgent(settings);
    const agent = bridgeAgent(bridgeState, agentId);
    const state = bridgeView === "stream" ? agent?.state || "error" : bridgeView;
    const renderKey = JSON.stringify([
      bridgeView,
      bridgeStateKey(bridgeState),
      agentId,
      settings.model,
      settings.transcribe_model,
      settings.reasoning,
      settings.token,
      purpose,
      recoveryStatus,
      bridgeConnection.snapshot().probeUp,
      bridgeUnauthorized,
    ]);
    if (renderKey === lastBridgeRenderKey) return;
    lastBridgeRenderKey = renderKey;

    if (bridgeView === "re_pair") {
      setSubscriptionHtml(host, `${recovery}<div id="bridge-surface" class="bridge-surface" data-state="re_pair">${bridgePairingMarkup()}</div>`);
      return;
    }
    if (bridgeView === "bridge_down" || bridgeView === "idle") {
      setSubscriptionHtml(host, `${recovery}<div id="bridge-surface" class="bridge-surface" data-state="bridge_down">${bridgeSetupMarkup()}</div>`);
      return;
    }
    if (bridgeView === "starting" || !agent) {
      setSubscriptionHtml(host, `${recovery}<div id="bridge-surface" class="bridge-surface" data-state="starting">${bridgeStartingMarkup()}</div>`);
      return;
    }

    const models = bridgeModelsFor(agentId);
    const body = state === "ready"
      ? bridgeReadyMarkup(settings, agentId)
      : state === "starting"
        ? bridgeStartingMarkup(agentId)
        : bridgeAgentStateMarkup(agent);
    const ready = state === "ready" && models.some((model) => model.id === settings.model);
    const finish = ready && (purpose !== "settings" || !getGenerationSetupStatus(settings).ready)
      ? `<div class="settings-section settings-complete-section"><${BUTTON_TAG} id="complete-model-setup" class="web-primary" type="button">${getGenerationSetupStatus(settings).ready ? "Done" : "Finish setup"}</button></div>`
      : "";
    setSubscriptionHtml(host, `${recovery}<div id="bridge-surface" class="bridge-surface" data-state="${escapeHtml(state)}"><div class="bridge-agent-body">${body}</div></div>${finish}`);
  }

  function renderConditionalSections() {
    if (!surface) return;
    mountConditionalHost();
    updateProviderRows();
    const host = surface.querySelector("#settings-conditional-sections");
    if (!host) return;
    const settings = loadSettings();
    const preset = providerFor(settings.preset);
    surface.querySelector("#settings-panel").dataset.preset = preset.id;
    if (preset.id === "subscriptions") {
      renderSubscriptionsSections(host, settings);
      return;
    }
    const currentModel = settings.model || preset.model;
    const transcribeModel = settings.transcribe_model || preset.transcribe_model || currentModel;
    const localCapability = preset.id === "local"
      ? pdfTranscriptionCapability(settings, localDiscovery === "success" || localDiscovery === "empty"
        ? { models: localModels || [] }
        : { models: null, discoveryError: localDiscovery === "error" })
      : pdfTranscriptionCapability(settings);
    const transcribeDisabled = preset.id === "local" && !localCapability.available;
    const transcribeLabel = transcribeDisabled
      ? (localCapability.status === "checking" ? "Checking…" : "Unavailable")
      : transcribeModel || "Choose a model";
    const localModelReady = preset.id !== "local"
      || (localDiscovery === "success" && !!localModels?.some((model) => model.id === settings.model));
    const endpointReady = preset.id !== "custom_endpoint" || endpointConnected(settings);
    const modelSection = preset.model_source === "catalog"
      ? `<div class="settings-section model-section"><div class="settings-row"><span class="settings-label" id="model-select-label">Model</span>${comboboxMarkup({ id: "model-select", valueId: "model-select-name", labelledBy: "model-select-label", value: currentModel, label: currentModel, title: currentModel, iconHtml: chevron })}</div></div>`
      : preset.id === "custom_endpoint"
        ? `<div class="settings-section model-section local-model-section"><div class="settings-row"><span class="settings-label" id="endpoint-model-label">Model</span>${comboboxMarkup({ id: "endpoint-model", labelledBy: "endpoint-model-label", value: currentModel, label: currentModel || "Choose a model", title: currentModel, iconHtml: chevron })}</div></div>`
        : `<div class="settings-section model-section local-model-section"><div class="settings-row"><span class="settings-label" id="local-model-label">Model</span>${comboboxMarkup({ id: "local-model", labelledBy: "local-model-label", value: currentModel, label: currentModel, title: currentModel, iconHtml: chevron })}</div><small class="field-hint">${escapeHtml(localDiscoveryCopy())}${localDiscovery === "error" || localDiscovery === "empty" ? ` <${BUTTON_TAG} id="local-model-setup" class="settings-text-action" type="button">Set up Local</button>` : ""}</small></div>`;
    const keySection = preset.requires_key || preset.allows_key ? `<div class="settings-section key-section">${fieldMarkup({ id: "api-key", type: "password", label: preset.key_label || `${preset.label} key`, value: getApiKey(settings), placeholder: apiKeyPlaceholder(settings.preset), autocomplete: "off", autocapitalize: "none", autocorrect: "off", inputmode: "text", enterkeyhint: "done", spellcheck: "false", toggleId: "api-key-toggle", toggleHtml: eyeSvg(false), labelAfterHtml: preset.id === "openrouter" ? `<a class="key-get" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key →</a>` : "", status: { id: "api-key-status", className: "key-status idle visible", text: keyIdleWhisper(preset) } })}<label class="settings-row remember-row" for="session-only"><span class="switch-copy"><strong>Remember on this device</strong><small>Turn off on shared computers.</small></span><span class="switch" aria-hidden="true"><input id="session-only" type="checkbox" role="switch" ${settings.session_only === false ? "checked" : ""}><span class="switch-track"></span></span></label></div>` : "";
    const endpointSection = preset.id === "local"
      ? `<details class="settings-advanced"><summary>Connection settings</summary><div class="settings-advanced-grid">${fieldMarkup({ id: "provider-base", label: "Endpoint", value: settings.base_url || "", placeholder: "http://localhost:11434/v1", hint: "Use an OpenAI-compatible endpoint." })}</div></details>`
      : preset.id === "custom_endpoint"
        ? `<div class="settings-section endpoint-section">${fieldMarkup({ id: "provider-base", label: "Endpoint", value: settings.base_url || "", placeholder: "https://api.example.com/v1", autocomplete: "off", autocapitalize: "none", autocorrect: "off", inputmode: "url", enterkeyhint: "done", spellcheck: "false", status: { id: "endpoint-status", className: `key-status ${endpointStatusTone()} visible`, text: endpointStatusCopy() || ENDPOINT_HINT } })}</div>`
        : "";
    const transcriptionSection = purpose === "setup"
      ? ""
      : `<div class="settings-section model-section transcription-model-section"><div class="settings-row">${transcriptionHelpMarkup(preset)}${comboboxMarkup({ id: "transcribe-model", labelledBy: "transcribe-model-label", describedBy: preset.id === "local" ? "transcribe-model-status" : "", value: transcribeDisabled ? "" : transcribeModel, label: transcribeLabel, title: transcribeDisabled ? localCapability.reason : transcribeModel, iconHtml: chevron, disabled: transcribeDisabled })}</div>${preset.id === "local" ? `<small id="transcribe-model-status" class="field-hint transcription-status ${escapeHtml(localCapability.status)}">${escapeHtml(transcriptionStatusCopy(localCapability))}${localDiscovery === "success" && !localCapability.available && localCapability.status !== "checking" ? ` <${BUTTON_TAG} id="local-vision-retry" class="settings-text-action" type="button">Recheck</button>` : ""}</small>` : ""}</div>`;
    const typed = textBeingTyped(host);
    setConditionalHtml(host, `${recoveryStatus ? `<div class="settings-section settings-recovery" role="status">${escapeHtml(recoveryStatus)}</div>` : ""}
      ${preset.id === "custom_endpoint" ? `${endpointSection}${keySection}${modelSection}` : `${modelSection}${keySection}${endpointSection}`}
      ${transcriptionSection}
      ${purpose !== "settings" || !getGenerationSetupStatus(settings).ready ? `<div class="settings-section settings-complete-section"><${BUTTON_TAG} id="complete-model-setup" class="web-primary" type="button"${localModelReady && endpointReady ? "" : " disabled"}>Finish setup</button></div>` : ""}`);
    restoreTextBeingTyped(host, typed);
    wireConditionalSections(host);
  }

  function bridgeModelsFor(agentId) {
    return bridgeModelsForAgent(bridgeState, agentId);
  }

  function bridgeModelName(id) {
    return bridgeState?.agents?.flatMap((agent) => agent.models || []).find((model) => model.id === id)?.name || "";
  }

  function selectedBridgeAgent(settings = loadSettings()) {
    if (settings.agent === "claude" || settings.agent === "codex") return settings.agent;
    return bridgeAgentOf(settings.model) || "claude";
  }

  function chooseInitialBridgeAgent(status) {
    for (const id of ["claude", "codex"]) {
      if (bridgeAgent(status, id)?.state === "ready") return id;
    }
    for (const id of ["claude", "codex"]) {
      if (bridgeAgent(status, id)?.state !== "missing") return id;
    }
    return "claude";
  }

  function bridgeAgentSnapshot(settings, agentId, agents = settings.agents || {}) {
    const saved = agents[agentId] || {};
    const ownsModel = bridgeAgentOf(settings.model) === agentId;
    const ownsTranscription = bridgeAgentOf(settings.transcribe_model) === agentId;
    return {
      model: ownsModel ? settings.model : String(saved.model || ""),
      reasoning: ownsModel ? String(settings.reasoning || "") : String(saved.reasoning || ""),
      transcribe_model: ownsTranscription ? settings.transcribe_model : String(saved.transcribe_model || ""),
    };
  }

  function bridgeSelection(settings, agentId, sourceAgents = settings.agents || {}) {
    const agents = { ...sourceAgents };
    const saved = bridgeAgentSnapshot(settings, agentId, agents);
    const models = bridgeModelsFor(agentId);
    if (!models.length) {
      agents[agentId] = saved;
      return { agent: agentId, agents, model: "", reasoning: "", transcribe_model: "" };
    }
    const model = models.find((entry) => entry.id === saved.model) || models[0];
    const reasoning = model.reasoning.options.includes(saved.reasoning)
      ? saved.reasoning
      : model.reasoning.default;
    const imageModels = models.filter((entry) => entry.vision);
    const transcribeModel = imageModels.find((entry) => entry.id === saved.transcribe_model)?.id
      || imageModels[0]?.id
      || "";
    agents[agentId] = {
      model: model.id,
      reasoning,
      transcribe_model: transcribeModel,
    };
    return {
      agent: agentId,
      agents,
      model: model.id,
      reasoning,
      transcribe_model: transcribeModel,
    };
  }

  function applyBridgeSelection(settings, agentId, agents = settings.agents || {}) {
    const next = bridgeSelection(settings, agentId, agents);
    if (JSON.stringify(canonicalBridgeSelection(settings)) !== JSON.stringify(canonicalBridgeSelection(next))) applyPatch(next);
    return next;
  }

  function canonicalBridgeSelection(value) {
    return [
      value.agent || "",
      value.model || "",
      value.reasoning || "",
      value.transcribe_model || "",
      ...["claude", "codex"].flatMap((agentId) => {
        const entry = value.agents?.[agentId] || {};
        return [entry.model || "", entry.reasoning || "", entry.transcribe_model || ""];
      }),
    ];
  }

  function patchSelectedBridgeAgent(patch) {
    const settings = loadSettings();
    const agentId = selectedBridgeAgent(settings);
    const agents = { ...(settings.agents || {}) };
    agents[agentId] = {
      ...bridgeAgentSnapshot(settings, agentId, agents),
      ...(Object.hasOwn(patch, "model") ? { model: patch.model } : {}),
      ...(Object.hasOwn(patch, "reasoning") ? { reasoning: patch.reasoning } : {}),
      ...(Object.hasOwn(patch, "transcribe_model") ? { transcribe_model: patch.transcribe_model } : {}),
    };
    applyPatch({ ...patch, agent: agentId, agents });
  }

  // Park the outgoing agent's per-agent settings and select the new one.
  function applyAgentSwitch(settings, agentId) {
    const currentAgent = selectedBridgeAgent(settings);
    if (agentId === currentAgent) return false;
    const agents = { ...(settings.agents || {}) };
    agents[currentAgent] = bridgeAgentSnapshot(settings, currentAgent, agents);
    applyBridgeSelection(settings, agentId, agents);
    return true;
  }

  function switchBridgeAgent(agentId) {
    if (agentId !== "claude" && agentId !== "codex") return;
    if (applyAgentSwitch(loadSettings(), agentId)) renderConditionalSections();
  }

  /* Paired but the stream is down — the returning user only needs the command. */
  function bridgeSetupMarkup() {
    return `<div class="settings-section bridge-setup-section"><h3>${escapeHtml(BRIDGE_DOWN_HEADING)}</h3><p class="bridge-setup-why">The bridge isn’t running. Start it in your terminal:</p>${bridgeCommandMarkup(BRIDGE_COMMAND)}<small class="field-hint">Rabbithole reconnects on its own once it’s up.</small></div>`;
  }

  function bridgePairingFieldMarkup({ inline }) {
    return `<div class="bridge-pair-grid settings-advanced-grid">${fieldMarkup({ id: "bridge-pairing-token", label: "Pairing link", value: "", placeholder: "https://rabbithole.ing/#bridge=…", autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false", status: { id: "bridge-pair-status", className: "key-status idle", text: "" } })}<${BUTTON_TAG} id="bridge-pair" class="web-primary"${inline ? " data-state-action" : ""} type="button">Connect</button></div>`;
  }

  /*
   * Unpaired (first run, or the bridge rejected our token). A live two-step
   * guide: the ping probe checks step 1 off the moment the bridge comes up,
   * so the panel always shows exactly one next action. The paste field stays
   * reachable pre-detection (collapsed) because a denied local-network
   * permission makes the probe blind while the bridge is actually fine.
   */
  function bridgePairingMarkup() {
    const heading = `<h3>${escapeHtml(BRIDGE_DOWN_HEADING)}</h3>`;
    if (bridgeConnection.snapshot().probeUp) {
      const lead = bridgeUnauthorized
        ? "This browser lost its pairing. Click the link in the bridge’s terminal to pair again — or paste it here:"
        : "Now click the link in your terminal to connect this page — or paste it here:";
      return `<div class="settings-section bridge-setup-section">${heading}<p class="bridge-setup-why bridge-setup-live"><span class="bridge-check" aria-hidden="true">✓</span> The bridge is running on this computer.</p><p class="bridge-step-lead">${escapeHtml(lead)}</p>${bridgePairingFieldMarkup({ inline: true })}</div>`;
    }
    const why = bridgeUnauthorized
      ? "This browser lost its pairing with the bridge. Connect it again:"
      : "Answers come from Claude Code or Codex running on this computer — included in the plan you already pay for.";
    return `<div class="settings-section bridge-setup-section">${heading}<p class="bridge-setup-why">${escapeHtml(why)}</p><div class="bridge-steps"><div class="bridge-step" data-step="run"><span class="bridge-step-marker" aria-hidden="true">1</span><div class="bridge-step-body"><p>Run this in your terminal:</p>${bridgeCommandMarkup(BRIDGE_COMMAND)}<small class="field-hint bridge-step-wait" role="status"><span class="ollama-spinner" aria-hidden="true"></span>Waiting for the bridge to start…</small></div></div><div class="bridge-step bridge-step-upcoming" data-step="connect"><span class="bridge-step-marker" aria-hidden="true">2</span><div class="bridge-step-body"><p>Click the link it prints to connect this page.</p></div></div></div><details class="bridge-paste-fallback"><summary>Paste the link instead</summary>${bridgePairingFieldMarkup({ inline: false })}</details></div>`;
  }

  function bridgeStartingMarkup(agentId = "") {
    const label = agentId ? BRIDGE_AGENT_LABELS[agentId] : "the bridge";
    return `<div class="settings-section bridge-agent-state bridge-starting" role="status"><span class="ollama-spinner" aria-hidden="true"></span><p>Connecting to ${escapeHtml(label)}…</p></div>`;
  }

  function bridgeCommandMarkup(command) {
    return `<div class="bridge-command"><code>${escapeHtml(command)}</code><${BUTTON_TAG} data-copy-command="${escapeHtml(command)}" data-state-action class="settings-text-action" type="button">Copy</button></div>`;
  }

  function bridgeAgentStateMarkup(agent) {
    const label = BRIDGE_AGENT_LABELS[agent?.id] || "Subscription agent";
    const copy = agent?.state === "missing"
      ? `${label} isn’t installed on this computer.`
      : agent?.state === "signed_out"
        ? `Sign in to ${label}.`
        : `${label} needs attention.`;
    // The bridge re-probes both CLIs on its own, so install/sign-in resolves
    // without a restart — say so, or the user goes hunting for a reload button.
    const followUp = agent?.state === "missing" || agent?.state === "signed_out"
      ? `<small class="field-hint">Rabbithole notices by itself — no restart needed.</small>`
      : "";
    return `<div class="settings-section bridge-agent-state"><p>${escapeHtml(copy)}</p>${agent?.detail ? `<small class="field-hint">${escapeHtml(agent.detail)}</small>` : ""}${bridgeCommandMarkup(agent?.fix || BRIDGE_COMMAND)}${followUp}</div>`;
  }

  function bridgeReadyMarkup(settings, agentId) {
    const model = bridgeModelName(settings.model) || settings.model;
    const modelSection = `<div class="settings-section model-section local-model-section"><div class="settings-row"><span class="settings-label" id="bridge-model-label">Model</span>${comboboxMarkup({ id: "bridge-model", labelledBy: "bridge-model-label", value: settings.model, label: model, title: settings.model, iconHtml: chevron })}</div></div>`;
    const transcriptionSection = purpose === "setup" ? "" : bridgeTranscriptionMarkup(settings, agentId);
    return `${modelSection}${reasoningSectionMarkup(settings)}${transcriptionSection}`;
  }

  function bridgeTranscriptionMarkup(settings, agentId) {
    const models = bridgeModelsFor(agentId).filter((model) => model.vision);
    const unavailable = !models.length;
    const reason = `${BRIDGE_AGENT_LABELS[agentId]} doesn’t offer a vision-capable model for PDF transcription.`;
    const model = unavailable ? "" : settings.transcribe_model;
    return `<div class="settings-section model-section transcription-model-section"><div class="settings-row">${transcriptionHelpMarkup(PROVIDERS.subscriptions, agentId)}${comboboxMarkup({ id: "transcribe-model", labelledBy: "transcribe-model-label", describedBy: unavailable ? "bridge-transcribe-status" : "", value: model, label: unavailable ? "Unavailable" : bridgeModelName(model), title: unavailable ? reason : model, iconHtml: chevron, disabled: unavailable })}</div>${unavailable ? `<small id="bridge-transcribe-status" class="field-hint transcription-status no_vision">${escapeHtml(reason)}</small>` : ""}</div>`;
  }

  function reasoningSectionMarkup(settings) {
    const model = bridgeState?.agents?.flatMap((agent) => agent.models || []).find((entry) => entry.id === settings.model);
    const options = model?.reasoning?.options || [];
    if (!options.length) return "";
    const active = options.includes(settings.reasoning) ? settings.reasoning : model.reasoning.default;
    return `<div class="settings-section reasoning-section"><span class="settings-label" id="reasoning-label">Reasoning</span><div class="reasoning-choice" role="group" aria-labelledby="reasoning-label">${options.map((option) => `<${BUTTON_TAG} type="button" data-reasoning="${escapeHtml(option)}" aria-pressed="${option === active}">${escapeHtml(reasoningLabel(option))}</button>`).join("")}</div></div>`;
  }

  function setBridgeView(view) {
    if (bridgeView === view) return;
    bridgeView = view;
    lastBridgeRenderKey = "";
    renderConditionalSections();
  }

  function acceptBridgeState(nextState) {
    const frameKey = bridgeStateKey(nextState);
    if (frameKey === lastBridgeFrameKey) return;
    lastBridgeFrameKey = frameKey;
    bridgeState = nextState;
    bridgeView = "stream";
    bridgeUnauthorized = false;
    applyBridgeSelectionFromState();
    lastBridgeRenderKey = "";
    renderConditionalSections();
    completeBridgeRecoveryIfReady();
    completePairingSetupIfReady();
  }

  function applyBridgeSelectionFromState() {
    if (!bridgeState) return;
    const current = loadSettings();
    if (providerFor(current.preset).id !== "subscriptions") return;
    const modelAgent = bridgeAgentOf(current.model);
    const agentId = current.agent === "claude" || current.agent === "codex"
      ? current.agent
      : modelAgent || chooseInitialBridgeAgent(bridgeState);
    const agents = { ...(current.agents || {}) };
    if (modelAgent) agents[modelAgent] = bridgeAgentSnapshot(current, modelAgent, agents);
    applyBridgeSelection(current, agentId, agents);
  }

  function startBridgeStream() {
    const settings = loadSettings();
    const token = String(settings.token || "").trim();
    const connectionKey = `${settings.base_url}\n${token}`;
    if (!token || providerFor(settings.preset).id !== "subscriptions" || bridgeConnection.snapshot().streamKey !== connectionKey) {
      bridgeState = null;
      lastBridgeFrameKey = "";
    }
    bridgeConnection.start();
  }

  function stopBridgeStream() {
    bridgeConnection.stopStream();
  }

  function stopBridgeProbe() {
    bridgeConnection.stopProbe();
  }

  function syncBridgeProbe() {
    bridgeConnection.syncProbe();
  }

  function completeBridgeRecoveryIfReady() {
    if (!bridgeRecoveryAgent || bridgeAgent(bridgeState, bridgeRecoveryAgent)?.state !== "ready" || !readyCallback) return;
    const callback = readyCallback;
    readyCallback = null;
    bridgeRecoveryAgent = "";
    markGenerationSetupComplete();
    onSettingsChange();
    close();
    void callback();
  }

  /*
   * Pairing arrived via the printed link. The agent, model, and reasoning
   * defaults are already chosen by the time the first ready frame lands, so
   * asking the user to also press "Finish setup" is pure ceremony — complete
   * it for them and leave the panel open so they can see (and adjust) what
   * was picked.
   */
  function beginPairingSetup({ trigger = defaultTrigger, onComplete = null } = {}) {
    pairingSetupPending = true;
    pairingSetupComplete = onComplete;
    open({ trigger, purpose: getGenerationSetupStatus().ready ? "settings" : "setup" });
    startBridgeStream();
    // A re-pair over a live stream gets no fresh frame to react to: re-run
    // the selection and completion against the state we already hold.
    if (bridgeView === "stream") {
      applyBridgeSelectionFromState();
      lastBridgeRenderKey = "";
      renderConditionalSections();
    }
    completePairingSetupIfReady();
  }

  function completePairingSetupIfReady() {
    if (!pairingSetupPending) return;
    const settings = loadSettings();
    const agentId = selectedBridgeAgent(settings);
    const agent = bridgeAgent(bridgeState, agentId);
    if (agent?.state !== "ready" || !bridgeModelsFor(agentId).some((model) => model.id === settings.model)) return;
    pairingSetupPending = false;
    const callback = pairingSetupComplete;
    pairingSetupComplete = null;
    markGenerationSetupComplete();
    onSettingsChange();
    lastBridgeRenderKey = "";
    renderConditionalSections();
    callback?.({ agentLabel: BRIDGE_AGENT_LABELS[agentId], plan: planLabel(agent.plan) });
  }

  function wireConditionalSections(host) {
    wireModelComboboxes(host);
    wireField(host, { id: "provider-base" });
    wireField(host, { id: "api-key", toggleId: "api-key-toggle", renderToggle: eyeSvg });
    wireField(host, { id: "bridge-pairing-token" });
    const keyInput = host.querySelector("#api-key");
    /** @type {ReturnType<typeof setTimeout> | 0} */ let timer = 0;
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
    host.querySelector("#provider-base")?.addEventListener("change", (event) => {
      applyPatch({ base_url: event.target.value.trim() });
      if (providerFor(loadSettings().preset).id === "custom_endpoint") void runEndpointDiscovery();
      else void runLocalDiscovery();
    });
    host.querySelector("#local-model-setup")?.addEventListener("click", launchOllamaRecovery);
    host.querySelector("#local-vision-retry")?.addEventListener("click", () => void runLocalDiscovery());
    host.querySelector("#complete-model-setup")?.addEventListener("click", () => void completeSetup());
    const pair = () => {
      const input = host.querySelector("#bridge-pairing-token");
      const status = host.querySelector("#bridge-pair-status");
      const pairing = pairingFromInput(input?.value);
      if (!pairing) {
        if (status) {
          status.textContent = "Copy the whole link from the bridge’s terminal, then paste it here.";
          status.className = "key-status invalid visible";
        }
        input?.classList.remove("shake-once");
        requestAnimationFrame(() => input?.classList.add("shake-once"));
        window.setTimeout(() => input?.classList.remove("shake-once"), 300);
        return;
      }
      applyPatch({
        token: pairing.token,
        ...(pairing.port ? { base_url: `http://127.0.0.1:${pairing.port}/v1` } : {}),
      });
      startBridgeStream();
    };
    host.querySelector("#bridge-pair")?.addEventListener("click", pair);
    host.querySelector("#bridge-pairing-token")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && !isCommandEnter(event)) return;
      event.preventDefault();
      pair();
    });
    host.querySelector(".bridge-paste-fallback")?.addEventListener("toggle", (event) => {
      if (event.target.open) host.querySelector("#bridge-pairing-token")?.focus({ preventScroll: true });
    });
    host.querySelectorAll("[data-copy-command]").forEach((button) => button.addEventListener("click", () => {
      void navigator.clipboard?.writeText(button.dataset.copyCommand).then(() => {
        button.textContent = "Copied";
        setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1400);
      }).catch(() => {});
    }));
    host.querySelectorAll("[data-reasoning]").forEach((button) => button.addEventListener("click", () => {
      if (button.getAttribute("aria-pressed") === "true") return;
      if (providerFor(loadSettings().preset).id === "subscriptions") patchSelectedBridgeAgent({ reasoning: button.dataset.reasoning });
      else applyPatch({ reasoning: button.dataset.reasoning });
      button.closest(".reasoning-choice")?.querySelectorAll("button").forEach((other) => other.setAttribute("aria-pressed", other === button ? "true" : "false"));
    }));
  }

  function selectedRowId(settings = loadSettings()) {
    const presetId = providerFor(settings.preset).id;
    return presetId === "subscriptions" ? selectedBridgeAgent(settings) : presetId;
  }

  /*
   * One conditional host, moved into the selected row's body. Every section
   * renderer keeps writing to #settings-conditional-sections; the list only
   * decides where that host lives.
   */
  function mountConditionalHost() {
    const host = surface?.querySelector("#settings-conditional-sections");
    const slot = surface?.querySelector(`[data-provider-item="${selectedRowId()}"] .provider-body-slot`);
    if (host && slot && host.parentElement !== slot) slot.append(host);
  }

  function rowStatus(rowId, settings) {
    const presetId = providerFor(settings.preset).id;
    if (rowId === "claude" || rowId === "codex") {
      if (presetId !== "subscriptions" || bridgeView !== "stream") return null;
      const state = bridgeAgent(bridgeState, rowId)?.state;
      if (state === "ready") return { text: "Ready", tone: "ok" };
      if (state === "missing") return { text: "Not installed", tone: "" };
      if (state === "signed_out") return { text: "Signed out", tone: "" };
      if (state === "error") return { text: "Needs attention", tone: "warn" };
      return null;
    }
    if (rowId === "openrouter") return openrouterKeyValid ? { text: "Connected", tone: "ok" } : null;
    if (rowId === "local") {
      if (presetId !== "local") return null;
      if (localDiscovery === "success") return { text: `${localModels.length} model${localModels.length === 1 ? "" : "s"}`, tone: "ok" };
      if (localDiscovery === "empty") return { text: "No models", tone: "" };
      return null;
    }
    if (rowId === "custom_endpoint") {
      if (presetId !== "custom_endpoint") return null;
      if (endpointDiscovery === "success" || endpointDiscovery === "empty") return { text: "Connected", tone: "ok" };
      return null;
    }
    return null;
  }

  function updateProviderRows() {
    if (!surface) return;
    const settings = loadSettings();
    const activeRow = selectedRowId(settings);
    surface.querySelectorAll("[data-provider-item]").forEach((item) => {
      const rowId = item.dataset.providerItem;
      const selected = rowId === activeRow;
      item.classList.toggle("selected", selected);
      const radio = item.querySelector(".provider-row");
      radio.setAttribute("aria-checked", selected ? "true" : "false");
      radio.tabIndex = selected ? 0 : -1;
      const chip = item.querySelector("[data-provider-chip]");
      const status = rowStatus(rowId, settings);
      chip.hidden = !status;
      chip.textContent = status?.text || "";
      chip.classList.toggle("ok", status?.tone === "ok");
      chip.classList.toggle("warn", status?.tone === "warn");
    });
  }

  function selectRow(rowId) {
    const row = PROVIDER_ROWS.find((entry) => entry.id === rowId);
    if (!row) return;
    const settings = loadSettings();
    if (row.preset !== providerFor(settings.preset).id) {
      switchProvider(row.preset, "agent" in row ? row.agent : "");
      return;
    }
    const agent = "agent" in row ? row.agent : "";
    if (agent && agent !== selectedBridgeAgent(settings)) switchBridgeAgent(agent);
  }

  function switchProvider(id, agentId = "") {
    const current = loadSettings();
    if (!id || id === providerFor(current.preset).id) return;
    localDiscoveryToken += 1; endpointDiscoveryToken += 1;
    lastKeyCommit = { value: null, result: false };
    if (id !== "subscriptions") {
      stopBridgeStream();
      stopBridgeProbe();
    }
    saveSettings({ ...current, api_key: getApiKey(current) });
    applyPatch(settingsForProvider(id, current));
    if (agentId) applyAgentSwitch(loadSettings(), agentId);
    recoveryStatus = ""; localModels = null; localDiscovery = "idle";
    endpointModels = null; endpointDiscovery = "idle"; endpointDiscoveryMessage = "";
    bridgeState = null; bridgeView = "idle"; lastBridgeFrameKey = ""; lastBridgeRenderKey = ""; bridgeUnauthorized = false;
    renderConditionalSections();
    if (id === "local") void runLocalDiscovery();
    if (id === "custom_endpoint") void runEndpointDiscovery();
    if (id === "subscriptions") startBridgeStream();
  }

  function wireProviderControl() {
    const list = surface.querySelector(".provider-list");
    const rows = [...list.querySelectorAll(".provider-row")];
    rows.forEach((button) => button.addEventListener("click", () => selectRow(button.dataset.provider)));
    list.addEventListener("keydown", (event) => {
      const index = rows.indexOf(document.activeElement);
      if (index < 0) return;
      let next = -1;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % rows.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + rows.length) % rows.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = rows.length - 1;
      if (next < 0) return;
      event.preventDefault();
      selectRow(rows[next].dataset.provider);
      rows[next].focus({ preventScroll: true });
    });
  }

  function endpointConnected(settings) {
    return isHttpUrl(settings.base_url) && !!String(settings.model || "").trim()
      && (endpointDiscovery === "success" || endpointDiscovery === "empty");
  }

  function endpointStatusTone() {
    if (endpointDiscovery === "loading") return "busy";
    if (endpointDiscovery === "success" || endpointDiscovery === "empty") return "valid";
    if (endpointDiscovery === "error") return "invalid";
    return "idle";
  }

  function endpointStatusCopy() {
    if (!String(loadSettings().base_url || "").trim()) return "";
    if (endpointDiscovery === "loading") return "Connecting…";
    if (endpointDiscovery === "success") {
      const count = endpointModels?.length || 0;
      return `Connected · ${count} model${count === 1 ? "" : "s"}`;
    }
    if (endpointDiscovery === "empty") return "Connected · no models listed";
    if (endpointDiscovery === "error") return endpointDiscoveryMessage;
    return "";
  }

  function endpointErrorCopy(error, baseUrl, hasKey) {
    if (error?.code === "invalid_url") return error.message;
    const status = Number(error?.status) || 0;
    if (status === 401 || status === 403) return hasKey ? "This endpoint rejected the key." : "This endpoint needs an API key.";
    if (status) return `Endpoint returned HTTP ${status}.`;
    // A blocked local-network prompt fails exactly like an unreachable host, so the one
    // line has to name the cause the user can actually act on first.
    if (addressSpaceOf(baseUrl) === "local") {
      return `Couldn't reach ${endpointHost(baseUrl)}. Allow local network access if your browser asked, and check that the server accepts requests from this page.`;
    }
    return `Couldn't reach ${endpointHost(baseUrl)}. Check the URL, and that the server allows requests from this page.`;
  }

  function endpointHost(baseUrl) {
    try { return new URL(String(baseUrl || "").trim()).host; } catch { return "that endpoint"; }
  }

  async function runEndpointDiscovery() {
    const settings = loadSettings();
    if (providerFor(settings.preset).id !== "custom_endpoint") return;
    const token = ++endpointDiscoveryToken;
    const baseUrl = String(settings.base_url || "").trim();
    if (!baseUrl) {
      endpointModels = null; endpointDiscovery = "idle"; endpointDiscoveryMessage = "";
      renderConditionalSections();
      return;
    }
    const apiKey = getApiKey(settings);
    endpointDiscovery = "loading"; endpointDiscoveryMessage = ""; renderConditionalSections();
    try {
      const models = await fetchOpenAICompatibleModels(baseUrl, { apiKey });
      if (token !== endpointDiscoveryToken) return;
      endpointModels = models;
      endpointDiscovery = models.length ? "success" : "empty";
      if (models.length) {
        const current = loadSettings();
        const patch = {};
        if (!models.some((model) => model.id === current.model) && !getGenerationSetupStatus(current).ready) patch.model = models[0].id;
        // Nothing here can tell which model sees images, so transcription follows the chat
        // model instead of silently switching itself off.
        if (!String(current.transcribe_model || "").trim()) patch.transcribe_model = patch.model || current.model || models[0].id;
        if (Object.keys(patch).length) applyPatch(patch);
      }
    } catch (error) {
      if (token !== endpointDiscoveryToken) return;
      endpointModels = null; endpointDiscovery = "error";
      endpointDiscoveryMessage = endpointErrorCopy(error, baseUrl, !!apiKey);
      renderConditionalSections();
      if (!apiKey && (error?.status === 401 || error?.status === 403)) surface?.querySelector("#api-key")?.focus({ preventScroll: true });
      return;
    }
    renderConditionalSections();
  }

  async function runLocalDiscovery() {
    if (providerFor(loadSettings().preset).id !== "local") return;
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
    if (providerFor(loadSettings().preset).id !== "local") return;
    const recoveryTrigger = activeTrigger;
    pendingLocalReadyCallback = readyCallback || pendingLocalReadyCallback;
    readyCallback = null;
    close();
    openOllamaRecovery({ settings: loadSettings(), trigger: recoveryTrigger });
  }

  async function completeSetup() {
    const settings = loadSettings(); const preset = providerFor(settings.preset);
    if (!settings.model) return;
    if (preset.requires_key) {
      const ok = await commitSettingsKey({ required: true });
      if (!ok) return;
    } else if (preset.id === "custom_endpoint") {
      if (surface?.querySelector("#api-key")?.value.trim()) await commitSettingsKey();
      if (!endpointConnected(loadSettings())) return;
    } else if (preset.id === "subscriptions") {
      if (bridgeView !== "stream" || !bridgeModelsFor(selectedBridgeAgent(settings)).some((model) => model.id === settings.model)) return;
    } else if (localDiscovery !== "success" || !localModels?.some((model) => model.id === settings.model)) return;
    markGenerationSetupComplete();
    onSettingsChange();
    const callback = readyCallback; readyCallback = null;
    close();
    await callback?.();
  }

  /** @param {any} model @param {{current?: string, recommended?: boolean, group?: string, itemIndex?: number}} [options] */
  function renderCatalogModelRow(model, { current = "", recommended = false, group = "", itemIndex = -1 } = {}) {
    const selected = model.id === current;
    return `${group ? `<div class="model-group-label">${escapeHtml(group)}</div>` : ""}<${BUTTON_TAG} type="button" class="model-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-value="${escapeHtml(model.id)}" data-label="${escapeHtml(model.name)}" data-item-index="${itemIndex}" title="${escapeHtml(model.id)}"><span class="model-check" aria-hidden="true">${selected ? "✓" : ""}</span><span class="model-option-name">${escapeHtml(model.name)}</span>${recommended ? `<span class="model-chip">Recommended</span>` : ""}<span class="model-option-price">${escapeHtml(formatModelPrice(model))}</span></button>`;
  }

  /** @param {any} model @param {{current?: string, group?: string, itemIndex?: number}} [options] */
  function renderBridgeModelRow(model, { current = "", group = "", itemIndex = -1 } = {}) {
    const selected = model.id === current;
    return `${group ? `<div class="model-group-label">${escapeHtml(group)}</div>` : ""}<${BUTTON_TAG} type="button" class="model-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-value="${escapeHtml(model.id)}" data-label="${escapeHtml(model.name)}" data-item-index="${itemIndex}" title="${escapeHtml(model.id)}"><span class="model-check" aria-hidden="true">${selected ? "✓" : ""}</span><span class="model-option-name">${escapeHtml(model.name)}</span><span class="model-option-price">${escapeHtml(model.vision ? "vision" : "")}</span></button>`;
  }

  function filterBridgeModels(models, query) {
    const needle = String(query || "").trim().toLowerCase();
    const list = models.filter((model) => !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle));
    return list.map((model, index) => ({ model, itemIndex: index }));
  }

  function renderExactModelRow(query) {
    return `<${BUTTON_TAG} type="button" class="model-option model-use-custom" role="option" aria-selected="false" data-value="${escapeHtml(query)}" data-label="${escapeHtml(query)}" data-free-text="true" title="${escapeHtml(query)}"><span class="model-check" aria-hidden="true"></span><span class="model-option-name">Use “${escapeHtml(query)}”</span><span class="model-option-price">as-is</span></button>`;
  }

  function modelNote(kind, content) {
    return `<div class="model-note combobox-${kind}">${content}</div>`;
  }

  function modelComboboxOptions({
    id,
    valueId = "",
    labelledBy,
    placeholder,
    load,
    current,
    loading,
    empty,
    error,
    onChange,
    filter = (models, query) => searchModels(models, query).map((model, itemIndex) => ({ model, itemIndex })),
    renderOption = null,
    catalog = false,
    allowExact = false,
    escapeHint = false
  }) {
    return {
      id,
      ...(valueId ? { valueId } : {}),
      labelledBy,
      placeholder,
      surfaceClassName: `combobox-surface ${catalog ? "model-combobox-surface" : "local-model-combobox-surface"} popover-surface`,
      listClassName: "combobox-list model-list",
      searchIconHtml: searchIcon,
      ...(escapeHint ? { searchAfterHtml: "<kbd>esc</kbd>" } : {}),
      ...(allowExact ? { freeText: renderExactModelRow } : {}),
      source: {
        load,
        filter,
        renderOption: renderOption || ((entry) => renderCatalogModelRow(entry.model, { current: current(), ...entry })),
        loading: () => modelNote("loading", loading),
        empty: (query) => modelNote("empty", typeof empty === "function" ? empty(query) : empty),
        error: (retry) => modelNote("error", `${error} ${retry}`)
      },
      onChange
    };
  }

  async function loadEndpointModels() {
    if (endpointModels) return endpointModels;
    const settings = loadSettings();
    return fetchOpenAICompatibleModels(settings.base_url, { apiKey: getApiKey(settings) });
  }

  function wireModelComboboxes(root) {
    const wire = (options) => {
      const controller = wireCombobox(root, options);
      conditionalComboboxes.push(controller);
      return controller;
    };
    const commit = (id) => { if (!id) return; applyPatch({ model: id }); };
    const commitTranscription = (id) => {
      if (!id) return;
      if (providerFor(loadSettings().preset).id === "subscriptions") patchSelectedBridgeAgent({ transcribe_model: id });
      else applyPatch({ transcribe_model: id });
    };
    wire(modelComboboxOptions({
      id: "model-select",
      valueId: "model-select-name",
      labelledBy: "model-select-label",
      placeholder: "Search every model on OpenRouter…",
      load: loadCatalog,
      filter: (models, query) => query ? searchModels(models, query).map((model, index) => ({ model, itemIndex: index })) : [...SUGGESTED_MODEL_IDS.map((id) => models.find((model) => model.id === id)).filter(Boolean).map((model, index) => ({ model, itemIndex: models.indexOf(model), group: index === 0 ? "Suggested" : "", recommended: model.id === RECOMMENDED_MODEL_ID })), ...models.map((model, index) => ({ model, itemIndex: index, group: index === 0 ? "All models" : "" }))],
      current: () => loadSettings().model,
      loading: "Loading models…",
      empty: (query) => query ? "No matching models." : "OpenRouter returned no models.",
      error: "Couldn't reach OpenRouter for the model list.",
      onChange: commit,
      catalog: true,
      allowExact: true,
      escapeHint: true
    }));
    const preset = providerFor(loadSettings().preset);
    if (preset.id === "local") {
      wire(modelComboboxOptions({
        id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Search installed vision models…",
        load: async () => localVisionModels(localModels || await discoverLocalModels(loadSettings().base_url)),
        current: () => loadSettings().transcribe_model,
        loading: "Checking installed vision models…", empty: "No installed vision models.",
        error: "Couldn't verify local vision models.", onChange: commitTranscription
      }));
    } else if (preset.id === "subscriptions") {
      wire(modelComboboxOptions({
        id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Choose a vision model…",
        load: async () => bridgeModelsFor(selectedBridgeAgent()).filter((model) => model.vision),
        filter: filterBridgeModels,
        renderOption: (entry) => renderBridgeModelRow(entry.model, { current: loadSettings().transcribe_model, ...entry }),
        current: () => loadSettings().transcribe_model,
        loading: "Checking vision support…", empty: "No vision-capable models.",
        error: `Couldn't load models from ${BRIDGE_AGENT_LABELS[selectedBridgeAgent()]}.`, onChange: commitTranscription
      }));
    } else if (preset.id === "custom_endpoint") {
      wire(modelComboboxOptions({
        id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Choose a PDF transcription model…",
        load: loadEndpointModels, current: () => loadSettings().transcribe_model,
        loading: "Loading models…", empty: (query) => query ? "No matching models." : "This endpoint listed no models.",
        error: "Couldn't load models from this endpoint.", onChange: commitTranscription, allowExact: true
      }));
    } else {
      wire(modelComboboxOptions({
        id: "transcribe-model", labelledBy: "transcribe-model-label", placeholder: "Choose a PDF transcription model…",
        load: loadCatalog,
        current: () => loadSettings().transcribe_model,
        loading: "Loading models…", empty: "No matching models.", error: "Couldn't load models.",
        onChange: commitTranscription, catalog: true, allowExact: true
      }));
    }
    if (root.querySelector("#endpoint-model")) {
      wire(modelComboboxOptions({
        id: "endpoint-model", labelledBy: "endpoint-model-label", placeholder: "Search models on this endpoint…",
        load: loadEndpointModels, current: () => loadSettings().model,
        loading: "Loading models…", empty: (query) => query ? "No matching models." : "This endpoint listed no models.",
        error: "Couldn't load models from this endpoint.", onChange: commit, allowExact: true, escapeHint: true
      }));
    }
    if (root.querySelector("#bridge-model")) {
      wire(modelComboboxOptions({
        id: "bridge-model", labelledBy: "bridge-model-label", placeholder: `Search ${BRIDGE_AGENT_LABELS[selectedBridgeAgent()]} models…`,
        load: async () => bridgeModelsFor(selectedBridgeAgent()),
        filter: filterBridgeModels,
        renderOption: (entry) => renderBridgeModelRow(entry.model, { current: loadSettings().model, ...entry }),
        current: () => loadSettings().model,
        loading: "Loading models…",
        empty: `${BRIDGE_AGENT_LABELS[selectedBridgeAgent()]} returned no models.`,
        error: `Couldn't load models from ${BRIDGE_AGENT_LABELS[selectedBridgeAgent()]}.`,
        onChange: (id) => {
          if (!id) return;
          const model = bridgeState?.agents?.flatMap((agent) => agent.models || []).find((entry) => entry.id === id);
          const options = model?.reasoning?.options || [];
          const settings = loadSettings();
          patchSelectedBridgeAgent({ model: id, reasoning: options.includes(settings.reasoning) ? settings.reasoning : (model?.reasoning?.default || "") });
          renderConditionalSections();
        },
        escapeHint: true
      }));
    }
    if (!root.querySelector("#local-model")) return;
    wire(modelComboboxOptions({
      id: "local-model", labelledBy: "local-model-label", placeholder: "Search installed Ollama models…",
      load: () => localModels || discoverLocalModels(loadSettings().base_url),
      current: () => loadSettings().model,
      loading: "Looking for installed models…", empty: (query) => query ? "No matching installed models." : "No models are installed yet.",
      error: "Couldn't reach the local model endpoint.", onChange: commit, allowExact: true, escapeHint: true
    }));
  }

  async function commitSettingsKey({ required = false } = {}) {
    const input = surface?.querySelector("#api-key"); const status = surface?.querySelector("#api-key-status");
    if (!input || !status) return false;
    const value = input.value.trim(); const preset = providerFor(loadSettings().preset); const token = ++keyToken;
    /*
     * A blur with an unchanged key re-states a verdict the status line already
     * shows — and rewriting it mid-click shifts the controls underneath the
     * pointer. Nothing changed, so say nothing and touch nothing.
     */
    if (!required && value && value === lastKeyCommit.value) return lastKeyCommit.result;
    if (!value) {
      lastKeyCommit = { value: "", result: false };
      if (preset.id === "openrouter") openrouterKeyValid = false;
      if (getApiKey(loadSettings())) {
        applyPatch({ api_key: "" });
        setKeyStatus(status, "Key removed.", "hint");
        if (preset.id === "custom_endpoint") void runEndpointDiscovery();
      } else setKeyStatus(status, required ? "Enter a key first." : keyIdleWhisper(preset), required ? "invalid" : "idle");
      updateProviderRows();
      return false;
    }
    const previousKey = getApiKey(loadSettings());
    const result = await validateKeyForPreset({ key: value, presetId: preset.id, statusEl: status, required, onShake: () => input.classList.add("shake-once") });
    if (token !== keyToken) return false;
    lastKeyCommit = { value, result: !!result };
    if (result) applyPatch({ api_key: value });
    if (result && preset.id === "custom_endpoint" && value !== previousKey) void runEndpointDiscovery();
    if (preset.id === "openrouter") {
      openrouterKeyValid = !!result;
      updateProviderRows();
    }
    return result;
  }

  /*
   * The pane is mounted by the settings sheet, not by this module: there is one
   * settings surface in the product, and Model is a section of it. The sheet
   * owns the frame and the gutter; this mounts only bare rows and whatever
   * expands beneath the selected one — never a container of its own.
   */
  function mountPane(host) {
    surface = host;
    const settings = loadSettings();
    const preset = providerFor(settings.preset);
    const selectedRow = selectedRowId(settings);
    surface.innerHTML = `<section id="settings-panel"><div class="provider-list" role="radiogroup" aria-label="Where answers come from">${PROVIDER_ROWS.map((row) => providerRowMarkup(row, row.id === selectedRow)).join("")}</div></section>`;
    const conditionalHost = document.createElement("div");
    conditionalHost.id = "settings-conditional-sections";
    surface.querySelector(`[data-provider-item="${selectedRow}"] .provider-body-slot`).append(conditionalHost);
    wireProviderControl();
    renderConditionalSections();
    if (surface.querySelector("#api-key")?.value.trim()) commitSettingsKey();
    // Discovery failures stay in Model settings. The guided dialog opens only
    // from the explicit Set up Local action rendered for error/empty states.
    if (preset.id === "local") void runLocalDiscovery();
    if (preset.id === "custom_endpoint") void runEndpointDiscovery();
    if (preset.id === "subscriptions") startBridgeStream();
    return unmountPane;
  }

  function unmountPane() {
    if (!surface) return;
    disposeConditionalComboboxes();
    lastBridgeRenderKey = "";
    surface = null;
    readyCallback = null;
    bridgeRecoveryAgent = "";
    pairingSetupPending = false;
    pairingSetupComplete = null;
    stopBridgeProbe();
  }

  function open({ focusKey = false, trigger = defaultTrigger, purpose: nextPurpose = "settings", status = "", onReady = null } = {}) {
    activeTrigger = trigger || defaultTrigger;
    purpose = nextPurpose;
    readyCallback = onReady;
    recoveryStatus = status;
    lastBridgeRenderKey = "";
    if (surface) {
      renderConditionalSections();
      openSettingsSheet({ section: "model", trigger: activeTrigger });
      return;
    }
    lastKeyCommit = { value: null, result: false };
    if (purpose === "setup" && !getGenerationSetupStatus(loadSettings()).ready) {
      localDiscoveryToken += 1;
      localModels = null; localDiscovery = "idle"; localDiscoveryMessage = "";
    }
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
    openSettingsSheet({
      section: "model",
      trigger: activeTrigger,
      initialFocus: () => (focusKey && !coarsePointer ? surface?.querySelector("#api-key") : null),
    });
  }

  function close() {
    if (!surface) return;
    closeSettingsSheet();
  }

  function completeLocalSetup() {
    markGenerationSetupComplete();
    onSettingsChange();
    const callback = pendingLocalReadyCallback || readyCallback;
    pendingLocalReadyCallback = null; readyCallback = null;
    void callback?.();
  }

  function showBridgeUnauthorized({ onReady = null } = {}) {
    bridgeRecoveryAgent = selectedBridgeAgent();
    readyCallback = onReady;
    stopBridgeStream();
    bridgeState = null;
    lastBridgeFrameKey = "";
    bridgeView = "re_pair";
    bridgeUnauthorized = true;
    lastBridgeRenderKey = "";
    if (surface) renderConditionalSections();
  }

  function recoverUnknownModel(agentId = selectedBridgeAgent()) {
    if (bridgeView !== "stream" || bridgeAgent(bridgeState, agentId)?.state !== "ready") return false;
    const current = loadSettings();
    const next = bridgeSelection(current, agentId, current.agents || {});
    if (!next.model) return false;
    applyPatch(next);
    lastBridgeRenderKey = "";
    renderConditionalSections();
    return true;
  }

  function recoverBridgeAgent(agentId, { trigger = defaultTrigger, status = "", onReady = null } = {}) {
    const current = loadSettings();
    if (providerFor(current.preset).id !== "subscriptions") return;
    if (agentId === "claude" || agentId === "codex") {
      const agents = { ...(current.agents || {}) };
      const currentAgent = selectedBridgeAgent(current);
      agents[currentAgent] = bridgeAgentSnapshot(current, currentAgent, agents);
      applyBridgeSelection(current, agentId, agents);
    }
    bridgeRecoveryAgent = agentId;
    open({ trigger, purpose: "recovery", status, onReady });
    startBridgeStream();
  }

  function syncSubscriptionStream() {
    if (providerFor(loadSettings().preset).id === "subscriptions") startBridgeStream();
    else {
      stopBridgeStream();
      stopBridgeProbe();
    }
  }

  return {
    open,
    close,
    mountPane,
    completeLocalSetup,
    isOpen: () => !!surface,
    beginPairingSetup,
    recoverBridgeAgent,
    recoverUnknownModel,
    showBridgeUnauthorized,
    syncSubscriptionStream,
  };
}

function keyIdleWhisper(preset) {
  if (preset.id === "custom_endpoint") return "Optional. Stored only in this browser, sent only to your endpoint.";
  return `Stored only in this browser, sent directly to ${preset.label}.`;
}
function apiKeyPlaceholder(presetId) { return presetId === "openrouter" ? "sk-or-v1-…" : "API key"; }
import { BUTTON_TAG } from "../../core/html/markup.js";
