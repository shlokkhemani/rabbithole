import { escapeHtml } from "../../core/utils.js";
import { openDialog } from "../../ui/primitives/dialog.js";
import { localVisionModels } from "../brain/pdf-transcription.js";
import {
  diagnoseOllama,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
  RECOMMENDED_OLLAMA_MODEL_SIZE,
  verifyOllamaModel,
} from "../brain/ollama-diagnostics.js";

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download/mac";
const ORIGIN_COMMANDS = `launchctl setenv OLLAMA_ORIGINS "https://rabbithole.ing"
osascript -e 'quit app "Ollama"'
open -a Ollama`;
const STEPS = ["browser", "ollama", "access", "model"];
const STEP_LABELS = { browser: "Browser", ollama: "Ollama", access: "Site access", model: "Model" };
const SUCCESS_DWELL_MS = 1100;

export function createOllamaRecoveryDialog({ onResolved } = {}) {
  let overlay = null;
  let dialog = null;
  let trigger = null;
  let settings = null;
  let resolving = false;
  let downloadController = null;
  let afterResolved = null;

  function open(options = {}) {
    if (overlay) return;
    settings = options.settings || {};
    trigger = options.trigger || null;
    afterResolved = options.onResolved || null;
    overlay = document.createElement("div");
    overlay.id = "ollama-recovery-modal";
    overlay.className = "ollama-recovery-modal";
    overlay.hidden = true;
    overlay.innerHTML = `<section id="ollama-recovery-card" class="ollama-recovery-card" tabindex="-1" aria-labelledby="ollama-recovery-title">
      <header class="ollama-recovery-header">
        <h1 id="ollama-recovery-title">Connect Ollama</h1>
        <button class="ollama-recovery-close" type="button" aria-label="Close Ollama setup">×</button>
      </header>
      <div class="ollama-recovery-steps" aria-label="Ollama setup progress"></div>
      <div id="ollama-recovery-content" class="ollama-recovery-content" aria-live="polite"></div>
    </section>`;
    document.body.append(overlay);
    overlay.querySelector(".ollama-recovery-close").addEventListener("click", close);
    const card = overlay.querySelector("#ollama-recovery-card");
    dialog = openDialog({
      backdrop: overlay,
      dialog: card,
      labelledby: "ollama-recovery-title",
      trigger,
      initialFocus: card,
      closeOnBackdrop: true,
      onClose: finishClose,
    });
    renderChecking("browser", "Checking this Mac…");
    void runDiagnosis(false);
  }

  function close() {
    dialog?.close("programmatic");
  }

  function finishClose() {
    downloadController?.abort();
    downloadController = null;
    overlay?.remove();
    overlay = null;
    dialog = null;
    settings = null;
    afterResolved = null;
    resolving = false;
  }

  async function runDiagnosis(requestPermission) {
    if (resolving) return;
    resolving = true;
    const scope = overlay;
    if (requestPermission) renderChecking("browser", "Waiting for browser access…", "", "Look for a permission prompt from your browser.");
    try {
      const result = await diagnoseOllama(settings?.base_url, { requestPermission });
      if (overlay !== scope) return;
      await renderResult(result);
    } finally {
      if (overlay === scope) resolving = false;
    }
  }

  async function renderResult(result) {
    switch (result.status) {
      case "permission_prompt":
        renderState({
          step: "browser", title: "Allow local network access", copy: "Rabbithole needs browser permission to connect to Ollama on this Mac.",
          primary: { label: "Continue", action: () => runDiagnosis(true) },
        });
        return;
      case "permission_denied":
        renderState({
          step: "browser", tone: "warn", title: "Local network access is blocked", copy: "Enable Local Network Access for rabbithole.ing in your browser's site settings, then retry.",
          primary: { label: "Retry", action: () => runDiagnosis(true) },
        });
        return;
      case "unreachable":
      case "timeout":
        renderState({
          step: "ollama", completeThrough: "browser", title: "Start Ollama", copy: "Open Ollama, or download it if it isn't installed on this Mac.",
          primary: { label: "Retry", action: () => runDiagnosis(true) },
          secondary: { label: "Download Ollama", href: OLLAMA_DOWNLOAD_URL },
        });
        return;
      case "origin_blocked":
        renderOriginStep(result);
        return;
      case "models_error":
        renderState({
          step: "model", completeThrough: "access", tone: "warn", title: "Couldn't list models", copy: "Ollama is running, but the model list request failed.",
          primary: { label: "Retry", action: () => runDiagnosis(true) },
        });
        return;
      case "incompatible":
        renderState({
          step: "ollama", completeThrough: "browser", tone: "warn", title: "Ollama not found at this address", copy: "Check the endpoint in Connection settings, then retry.",
          primary: { label: "Retry", action: () => runDiagnosis(true) },
        });
        return;
      case "no_models":
        renderDownloadStep(result);
        return;
      case "ready":
        await verifyAndFinish(result);
        return;
      default:
        renderState({ step: "ollama", tone: "warn", title: "Connection failed", copy: "Rabbithole couldn't finish checking Ollama.", primary: { label: "Retry", action: () => runDiagnosis(true) } });
    }
  }

  function renderOriginStep(result) {
    renderState({
      step: "access", completeThrough: "ollama", title: "Allow rabbithole.ing", copy: "Run this once in Terminal. It tells Ollama to accept requests from Rabbithole.",
      code: ORIGIN_COMMANDS,
      primary: { label: "Copy commands", action: async (button) => {
        await copyText(ORIGIN_COMMANDS);
        swapButtonLabel(button, "Copied");
        setTimeout(() => { if (button.isConnected) swapButtonLabel(button, "Copy commands"); }, 1600);
      } },
      secondary: { label: "Retry", action: () => runDiagnosis(true) },
    });
  }

  function renderDownloadStep(result) {
    renderState({
      step: "model", completeThrough: "access", title: "Install a model", copy: "Ollama is connected, but has no models yet. This one is recommended for most Macs.",
      model: { name: RECOMMENDED_OLLAMA_MODEL, size: RECOMMENDED_OLLAMA_MODEL_SIZE, meta: "Text and vision" },
      primary: { label: "Download model", action: () => downloadModel(result) },
    });
  }

  async function downloadModel(result) {
    downloadController?.abort();
    downloadController = new AbortController();
    const scope = overlay;
    const progressUi = beginDownloadUi();
    try {
      await pullOllamaModel(settings?.base_url, RECOMMENDED_OLLAMA_MODEL, {
        signal: downloadController.signal,
        onProgress: (progress) => updateDownloadUi(progressUi, progress),
      });
      if (overlay !== scope) return;
      renderChecking("model", "Checking the model…", "access");
      const next = await diagnoseOllama(settings?.base_url, { requestPermission: true, timeoutMs: 12000 });
      if (overlay !== scope) return;
      await renderResult(next);
    } catch (error) {
      if (error?.name === "AbortError" || overlay !== scope) return;
      renderState({
        step: "model", completeThrough: "access", tone: "warn", title: "Download failed", copy: error?.message || "Ollama couldn't download the model.",
        primary: { label: "Retry download", action: () => downloadModel(result) },
        secondary: { label: "Recheck Ollama", action: () => runDiagnosis(true) },
      });
    }
  }

  function beginDownloadUi() {
    renderSteps("model", "access");
    const stage = setStage(`<div class="ollama-recovery-stage">
      <h2>Downloading model</h2>
      ${modelCardHtml({ name: RECOMMENDED_OLLAMA_MODEL, size: RECOMMENDED_OLLAMA_MODEL_SIZE, meta: "Text and vision" })}
      <div class="ollama-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Downloading ${escapeHtml(RECOMMENDED_OLLAMA_MODEL)}"><span></span></div>
      <div class="ollama-progress-meta"><span class="ollama-progress-status">Preparing…</span><span class="ollama-progress-percent"></span></div>
      <div class="ollama-recovery-actions"><button id="ollama-cancel-download" class="ollama-secondary" type="button">Cancel</button></div>
    </div>`);
    stage?.querySelector("#ollama-cancel-download")?.addEventListener("click", () => {
      downloadController?.abort();
      void runDiagnosis(true);
    });
    return {
      bar: stage?.querySelector(".ollama-progress"),
      fill: stage?.querySelector(".ollama-progress span"),
      status: stage?.querySelector(".ollama-progress-status"),
      percent: stage?.querySelector(".ollama-progress-percent"),
      largestTotal: 0,
    };
  }

  function updateDownloadUi(ui, progress) {
    if (!ui?.bar?.isConnected) return;
    const label = humanizePullStatus(progress.status);
    // Ollama pulls several layers; only the largest one meaningfully tracks
    // the download, so smaller layers update the label without moving the bar.
    const leadsDownload = progress.total > 0 && progress.total >= ui.largestTotal;
    if (leadsDownload) {
      ui.largestTotal = progress.total;
      const percent = Math.round(progress.fraction * 100);
      ui.bar.setAttribute("aria-valuenow", String(percent));
      ui.fill.style.width = `${percent}%`;
      ui.status.textContent = `${label} · ${formatBytes(progress.completed)} of ${formatBytes(progress.total)}`;
      ui.percent.textContent = `${percent}%`;
    } else {
      ui.status.textContent = `${label}…`;
    }
  }

  async function verifyAndFinish(result) {
    const scope = overlay;
    const model = chooseModel(result.models, settings?.model);
    renderChecking("model", `Waking ${modelLabel(model)}…`, "access", "The first response can take a moment.");
    try {
      await verifyOllamaModel(settings?.base_url, model.id);
      if (overlay !== scope) return;
      const visionModels = localVisionModels(result.models);
      const transcribeModel = visionModels.find((entry) => entry.id === model.id)?.id || visionModels[0]?.id || settings?.transcribe_model || model.id;
      renderSuccess(model);
      setTimeout(async () => {
        if (overlay !== scope) return;
        const callback = onResolved;
        const completion = afterResolved;
        afterResolved = null;
        close();
        await callback?.({ models: result.models, model: model.id, transcribeModel });
        await completion?.({ models: result.models, model: model.id, transcribeModel });
      }, SUCCESS_DWELL_MS);
    } catch (error) {
      if (overlay !== scope) return;
      renderState({
        step: "model", completeThrough: "access", tone: "warn", title: "Model test failed", copy: `${modelLabel(model)} didn't respond. It may still be loading.`,
        primary: { label: "Retry test", action: () => verifyAndFinish(result) }, secondary: { label: "Recheck Ollama", action: () => runDiagnosis(true) },
      });
    }
  }

  function renderSuccess(model) {
    renderSteps("model", "model");
    setStage(`<div class="ollama-recovery-stage ollama-recovery-success"><span class="ollama-success-check" aria-hidden="true">✓</span><h2>Connected</h2><p>Using ${escapeHtml(modelLabel(model))}.</p></div>`);
  }

  function renderChecking(step, title, completeThrough = "", note = "") {
    if (!overlay) return;
    renderSteps(step, completeThrough);
    setStage(`<div class="ollama-recovery-stage ollama-recovery-checking"><span class="ollama-spinner" aria-hidden="true"></span><h2>${escapeHtml(title)}</h2>${note ? `<p class="ollama-checking-note">${escapeHtml(note)}</p>` : ""}</div>`);
  }

  function renderState({ step, completeThrough = "", tone = "", title, copy, code, model, primary, secondary }) {
    if (!overlay) return;
    renderSteps(step, completeThrough);
    const stage = setStage(`<div class="ollama-recovery-stage"${tone ? ` data-tone="${escapeHtml(tone)}"` : ""}><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p>
      ${model ? modelCardHtml(model) : ""}
      ${code ? `<div class="ollama-command"><code>${code.split("\n").map((line) => `<span class="ollama-command-line">${escapeHtml(line)}</span>`).join("")}</code></div>` : ""}
      <div class="ollama-recovery-actions">${primary ? `<button id="ollama-primary-action" class="web-primary" type="button"><span class="ollama-btn-label">${escapeHtml(primary.label)}</span></button>` : ""}${secondary ? (secondary.href ? `<a class="ollama-secondary" href="${escapeHtml(secondary.href)}" target="_blank" rel="noreferrer">${escapeHtml(secondary.label)}</a>` : `<button id="ollama-secondary-action" class="ollama-secondary" type="button">${escapeHtml(secondary.label)}</button>`) : ""}</div></div>`);
    if (primary) stage?.querySelector("#ollama-primary-action")?.addEventListener("click", (event) => primary.action(event.currentTarget));
    if (secondary?.action) stage?.querySelector("#ollama-secondary-action")?.addEventListener("click", (event) => secondary.action(event.currentTarget));
  }

  function setStage(html) {
    const content = overlay?.querySelector("#ollama-recovery-content");
    if (!content) return null;
    const previousHeight = content.offsetHeight;
    content.innerHTML = html;
    if (previousHeight > 0 && typeof content.animate === "function" && !prefersReducedMotion()) {
      const nextHeight = content.offsetHeight;
      if (nextHeight > 0 && nextHeight !== previousHeight) {
        content.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          { duration: 200, easing: "cubic-bezier(.23, 1, .32, 1)" },
        );
      }
    }
    const card = overlay.querySelector("#ollama-recovery-card");
    if (card && !card.contains(document.activeElement)) {
      try { card.focus({ preventScroll: true }); } catch {}
    }
    return content.firstElementChild;
  }

  function renderSteps(active, completeThrough = "") {
    const completeIndex = STEPS.indexOf(completeThrough);
    const activeIndex = STEPS.indexOf(active);
    overlay.querySelector(".ollama-recovery-steps").innerHTML = `<span>${escapeHtml(STEP_LABELS[active] || active)}</span><span>${activeIndex + 1} of ${STEPS.length}</span><div>${STEPS.map((_, index) => {
      if (completeIndex >= index || activeIndex > index) return `<i class="done"></i>`;
      if (activeIndex === index) return `<i class="active"></i>`;
      return "<i></i>";
    }).join("")}</div>`;
  }

  return { open, close };
}

function modelCardHtml(model) {
  return `<div class="ollama-model-card"><span class="ollama-model-glyph" aria-hidden="true">✦</span><span class="ollama-model-id"><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.meta)}</small></span><span class="ollama-model-size">${escapeHtml(model.size)}</span></div>`;
}

function chooseModel(models, configured) {
  return models.find((model) => model.id === configured)
    || localVisionModels(models)[0]
    || models[0];
}

function modelLabel(model) {
  return model?.name || model?.id || "your model";
}

function humanizePullStatus(status) {
  const raw = String(status || "").toLowerCase();
  if (raw.includes("manifest") && !raw.includes("writing")) return "Preparing";
  if (raw.startsWith("pulling")) return "Downloading";
  if (raw.includes("verifying")) return "Verifying";
  if (raw.includes("writing") || raw.includes("removing") || raw.includes("success")) return "Finishing";
  return "Downloading";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 9.95e9 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function swapButtonLabel(button, text) {
  const label = button.querySelector(".ollama-btn-label");
  if (!label) { button.textContent = text; return; }
  if (!button.style.minWidth) button.style.minWidth = `${button.offsetWidth}px`;
  if (prefersReducedMotion()) { label.textContent = text; return; }
  label.classList.add("is-swapping");
  setTimeout(() => {
    if (!label.isConnected) return;
    label.textContent = text;
    label.classList.remove("is-swapping");
  }, 120);
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  const area = document.createElement("textarea");
  area.value = value; area.style.position = "fixed"; area.style.opacity = "0";
  document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
}
