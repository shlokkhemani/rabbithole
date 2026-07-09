import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, defaultBrainSettings, presetFor, settingsForPreset, BRAIN_PRESETS } from "./brain/index.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { activateFocusTrap } from "../ui/focus-trap.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml, buildSnapshotJson } from "../ui/snapshot.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { downloadRabbitholeExport, importRabbitholeFile, importSessionJsonFile, rabbitholeFilename } from "./portable.js";
import { testedModelHint } from "./brain/tested-models.js";

const SETTINGS_KEY = "rh-web-settings";
const KEY_KEY = "rh-web-api-key";
const AGENT_COMMAND = "claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole";
const OPENROUTER_WALKTHROUGH_URL = "https://openrouter.ai/docs/quickstart";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

const store = new IdbStore();
let memoryKey = "";
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;

applyInitialWebTheme();

boot().catch((err) => {
  document.body.innerHTML = `<main class="web-fatal"><h1>Rabbithole</h1><p>${escapeHtml(err?.message || String(err))}</p></main>`;
});

async function boot() {
  document.body.classList.add("web-app");
  const holeId = holeIdFromHash();
  if (holeId) {
    const hole = await store.loadHole(holeId);
    if (!hole) {
      history.replaceState(null, "", location.pathname);
      await renderHome();
      return;
    }
    await startHole(hole, { replace: true });
  } else {
    await renderHome();
  }
}

async function renderHome() {
  uiStarted = false;
  currentHost = null;
  currentHoleId = null;
  document.documentElement.classList.add("web-home-active");
  document.documentElement.classList.remove("web-canvas-active");
  document.body.classList.remove("mode-canvas");
  document.body.innerHTML = `<main class="web-home">
    <header class="home-hero">
      <div class="home-nav">
        <div class="home-wordmark">
          <span class="home-mark">${bunnyMarkSvg()}</span>
          <h1>Rabbithole</h1>
        </div>
        <button class="web-secondary settings-open" id="settings-open" type="button" aria-controls="settings-panel" aria-expanded="false">Settings</button>
      </div>
      <p class="home-promise">An infinite canvas for learning.</p>
      <p class="home-lede">Open a document, select what makes you curious, ask, and the answer opens beside it.</p>
    </header>

    <section class="hole-list-wrap" id="saved-section">
      <div class="hole-list-head">
        <h2>Saved holes</h2>
        <button id="refresh-list" class="web-secondary" type="button">Refresh</button>
      </div>
      <div id="hole-list" class="hole-list"></div>
    </section>

    <section class="new-hole" aria-labelledby="composer-heading">
      <div class="new-hole-main">
        <div class="composer-head">
          <div>
            <h2 id="composer-heading">Open a document</h2>
            <p>Paste markdown, drop a PDF, or open a URL.</p>
          </div>
          <label class="drop-md" id="drop-md">
            <input id="file-md" type="file" accept=".md,.markdown,.pdf,.rabbithole,.json,text/markdown,text/plain,application/pdf,application/json">
            <span>Choose file</span>
          </label>
        </div>
        <label class="field title-field" for="new-title">
          <span>Title</span>
          <input id="new-title" class="web-input" placeholder="Untitled Rabbithole" autocomplete="off">
        </label>
        <label class="field paste-field" for="paste-md">
          <span>Markdown or notes</span>
          <textarea id="paste-md" class="paste-md" placeholder="Paste markdown, notes, or source text here."></textarea>
        </label>
        <label class="switch-field author-toggle" for="improve-structure">
          <input id="improve-structure" type="checkbox" role="switch">
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-copy"><strong>Improve structure</strong><small>Use the author model before opening.</small></span>
        </label>
        <div class="composer-footer">
          <p class="drop-hint">Drop .md, .pdf, or .rabbithole anywhere here.</p>
          <button id="create-hole" class="web-primary" type="button">Open on the canvas</button>
        </div>
        <div class="url-open-row">
          <label class="field url-field" for="open-url-input">
            <span>URL</span>
            <input id="open-url-input" class="web-input" placeholder="https://example.com/paper.pdf" inputmode="url" autocomplete="url">
          </label>
          <button id="open-url" class="web-secondary" type="button">Open URL</button>
        </div>
        <div id="ingest-status" class="ingest-status" aria-live="polite" aria-atomic="true"></div>
      </div>
    </section>

    <section class="settings-panel home-settings" id="settings-panel" aria-label="AI provider settings"></section>

    <section class="home-footnotes" aria-label="Setup notes">
      <span class="agent-path">Using a coding agent? <code>${escapeHtml(AGENT_COMMAND)}</code> <button class="copy-command" type="button" data-copy-agent>Copy</button></span>
    </section>
  </main><div id="web-toast" class="web-toast" aria-live="polite"></div>`;

  initSettingsPanel();
  const settings = loadSettings();
  const needsKey = presetFor(settings.preset).requires_key && !getApiKey(settings);
  const settingsPanel = document.getElementById("settings-panel");
  const settingsOpen = document.getElementById("settings-open");
  settingsPanel.classList.toggle("expanded", needsKey);
  settingsPanel.classList.toggle("needs-key", needsKey);
  settingsOpen.setAttribute("aria-expanded", settingsPanel.classList.contains("expanded") ? "true" : "false");
  document.getElementById("settings-open").addEventListener("click", () => {
    settingsPanel.classList.toggle("expanded");
    settingsOpen.setAttribute("aria-expanded", settingsPanel.classList.contains("expanded") ? "true" : "false");
    if (settingsPanel.classList.contains("expanded")) {
      settingsPanel.querySelector("select, input, button, summary")?.focus();
    }
  });
  document.getElementById("create-hole").addEventListener("click", createFromPaste);
  document.getElementById("open-url").addEventListener("click", createFromUrl);
  document.getElementById("open-url-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createFromUrl();
    }
  });
  document.getElementById("refresh-list").addEventListener("click", renderHoleList);
  document.querySelectorAll("[data-copy-agent]").forEach((button) => {
    button.addEventListener("click", () => copyText(AGENT_COMMAND, "Command copied."));
  });
  initDrop();
  window.__rhWebApp = {
    store,
    importRabbitholeForTest: (text) => importRabbitholeFile(store, text),
    exportRabbitholeForTest: (id) => downloadRabbitholeExport(store, id),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => id ? store.readRawHoleForTest(id) : null,
  };
  await renderHoleList();
}

async function renderHoleList() {
  const listEl = document.getElementById("hole-list");
  if (!listEl) return;
  const holes = await store.listHoles();
  if (!holes.length) {
    listEl.innerHTML = `<div class="hole-empty">No saved holes yet.</div>`;
    return;
  }
  listEl.innerHTML = holes.map((hole) => `<article class="hole-row" data-hole="${escapeAttr(hole.hole_id)}">
    <button class="hole-open" type="button">
      <span class="hole-title">${escapeHtml(hole.title || "Untitled")}</span>
      <span class="hole-meta"><span>${escapeHtml(formatRelativeDate(hole.updated_at))}</span><span>${hole.node_count} ${hole.node_count === 1 ? "node" : "nodes"}</span></span>
    </button>
    <div class="hole-actions">
      <button class="hole-export" type="button" aria-label="Export ${escapeAttr(hole.title || "Untitled")}">Export</button>
      <button class="hole-delete" type="button" aria-label="Delete ${escapeAttr(hole.title || "Untitled")}">Delete</button>
    </div>
  </article>`).join("");
  listEl.querySelectorAll(".hole-open").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".hole-row");
      const hole = await store.loadHole(row.dataset.hole);
      if (hole) await startHole(hole);
    });
  });
  listEl.querySelectorAll(".hole-delete").forEach((button) => {
    button.addEventListener("click", () => deleteHoleFromHome(button.closest(".hole-row").dataset.hole));
  });
  listEl.querySelectorAll(".hole-export").forEach((button) => {
    button.addEventListener("click", () => exportHoleFromHome(button.closest(".hole-row").dataset.hole));
  });
}

async function createFromPaste() {
  const title = document.getElementById("new-title").value.trim();
  const markdown = document.getElementById("paste-md").value.trim();
  if (!markdown) {
    showToast({ message: "Paste markdown first." });
    return;
  }
  try {
    const authored = await maybeAuthorMarkdown({
      title,
      markdown,
      sourceName: "pasted text",
      kind: "paste",
    });
    const hole = createHoleFromMarkdown({ title, markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Authoring failed. ${err?.message || String(err)}`, "error");
  }
}

function initDrop() {
  const drop = document.getElementById("drop-md");
  const zone = document.querySelector(".new-hole");
  const input = document.getElementById("file-md");
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await createFromFile(file);
    input.value = "";
  });
  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
      drop.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
      drop.classList.remove("dragging");
    });
  }
  zone.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
}

async function createFromFile(file) {
  if (isRabbitholeFile(file)) {
    await createFromRabbitholeFile(file);
    return;
  }
  if (isSessionJsonFile(file)) {
    await createFromSessionJsonFile(file);
    return;
  }
  if (isPdfFile(file)) {
    await createFromPdfFile(file);
    return;
  }
  if (!isMarkdownFile(file)) {
    setIngestStatus("Choose a markdown, PDF, .rabbithole, or session JSON file.", "error");
    return;
  }
  try {
    setIngestStatus("Reading markdown file...", "busy");
    const markdown = await file.text();
    const title = document.getElementById("new-title").value.trim() || file.name.replace(/\.[^.]+$/, "");
    const authored = await maybeAuthorMarkdown({
      title,
      markdown,
      sourceName: file.name,
      kind: "file",
    });
    const hole = createHoleFromMarkdown({ title, markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Markdown import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromSessionJsonFile(file) {
  try {
    setIngestStatus("Importing Rabbithole session JSON...", "busy");
    const imported = await importSessionJsonFile(store, file);
    setIngestStatus("");
    const hole = await store.loadHole(imported.hole_id);
    if (!hole) throw new Error("Imported session JSON could not be loaded.");
    await startHole(hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function createFromRabbitholeFile(file) {
  try {
    setIngestStatus("Importing Rabbithole file...", "busy");
    const imported = await importRabbitholeFile(store, file);
    setIngestStatus("");
    const hole = await store.loadHole(imported.hole_id);
    if (!hole) throw new Error("Imported file could not be loaded.");
    await startHole(hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function createFromPdfFile(file) {
  try {
    const { ingestPdfToStoredHole } = await import("./ingest/pdf.js");
    setIngestStatus("Loading PDF importer...", "busy");
    const title = document.getElementById("new-title").value.trim();
    const { hole } = await ingestPdfToStoredHole({
      source: file,
      store,
      title,
      onProgress: ({ page, index, total }) => {
        if (page) setIngestStatus(`Importing PDF page ${index}/${total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`PDF import failed. ${err?.message || String(err)} Paste the text manually or drop a different PDF.`, "error");
  }
}

async function createFromUrl() {
  const rawUrl = document.getElementById("open-url-input").value.trim();
  if (!rawUrl) {
    setIngestStatus("Enter a URL first.", "error");
    return;
  }
  try {
    const settings = loadSettings();
    const title = document.getElementById("new-title").value.trim();
    setIngestStatus("Fetching URL...", "busy");
    const { hole } = await openUrlToStoredHole({
      rawUrl,
      store,
      title,
      proxyBaseUrl: settings.fetch_proxy_url || "",
      transformMarkdown: shouldImproveStructure()
        ? ({ markdown, title: sourceTitle, baseUrl }) => maybeAuthorMarkdown({
            title: sourceTitle,
            markdown,
            baseUrl,
            sourceName: rawUrl,
            kind: "url",
          })
        : null,
      onProgress: (progress) => {
        if (progress.phase === "fetch") setIngestStatus(`Fetching URL via ${progress.via}...`, "busy");
        else if (progress.phase === "page") setIngestStatus(`Importing PDF page ${progress.index}/${progress.total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function deleteHoleFromHome(holeId) {
  const hole = await store.loadHole(holeId);
  if (!hole) return;
  const assets = [];
  for (const name of await store.listAssets(holeId)) {
    assets.push({ name, blob: await store.getAsset(holeId, name) });
  }
  await store.deleteHole(holeId);
  await renderHoleList();
  showToast({
    message: `Deleted "${hole.title || "Untitled"}"`,
    actionLabel: "Undo",
    timeoutMs: 10000,
    onAction: async () => {
      await store.saveHole(hole);
      for (const asset of assets) {
        if (asset.blob) await store.putAsset(holeId, asset.name, asset.blob);
      }
      await renderHoleList();
    },
  });
}

async function exportHoleFromHome(holeId) {
  try {
    const payload = await downloadRabbitholeExport(store, holeId);
    showToast({ message: `Exported ${rabbitholeFilename(payload.hole?.title)}.` });
  } catch (err) {
    showToast({ message: err?.message || String(err) });
  }
}

async function maybeAuthorMarkdown({ title = "", markdown = "", sourceName = "", kind = "source", baseUrl = "" } = {}) {
  if (!shouldImproveStructure()) return markdown;
  const settings = loadSettings();
  const key = getApiKey(settings);
  if (presetFor(settings.preset).requires_key && !key) {
    throw new Error("Add a provider key in Settings before using Improve structure.");
  }
  setIngestStatus("Improving structure with the author model...", "busy");
  const brain = createBrain(settings, key);
  const controller = new AbortController();
  let out = "";
  for await (const chunk of brain.authorDocument({
    title,
    markdown,
    source_name: sourceName,
    kind,
    base_url: baseUrl,
  }, controller.signal)) {
    out += chunk;
    if (out.length) setIngestStatus(`Improving structure... ${out.length.toLocaleString()} characters`, "busy");
  }
  return out.trim() || markdown;
}

function shouldImproveStructure() {
  return document.getElementById("improve-structure")?.checked === true;
}

async function startHole(hole, { replace = false } = {}) {
  if (uiStarted) {
    location.hash = `hole=${encodeURIComponent(hole.hole_id)}`;
    location.reload();
    return;
  }
  uiStarted = true;
  currentHoleId = hole.hole_id;
  document.documentElement.classList.remove("web-home-active");
  document.documentElement.classList.add("web-canvas-active");
  if (replace) history.replaceState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);
  else history.pushState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);

  document.body.innerHTML = `<div class="web-canvas-bar">
    <button id="web-home" class="web-secondary" type="button">Home</button>
    <button id="web-settings" class="web-secondary" type="button">Settings</button>
  </div>
  <div id="web-settings-modal" class="web-settings-modal" hidden><div class="web-settings-dialog"><button id="web-settings-close" class="web-close" type="button">Close</button><div id="settings-panel" class="settings-panel expanded"></div></div></div>
  <div id="canvas-root">${CANVAS_SHELL}</div>
  <div id="web-toast" class="web-toast" aria-live="polite"></div>`;

  initCanvasSettings();
  setSnapshotHooks({
    fetchAssetData: async (name) => blobToDataUrl(await store.getAsset(currentHoleId, name)),
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
  });

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !presetFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  currentHost = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    onToast: showToast,
    onDone: () => {
      history.pushState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => location.reload(),
  });

  const hydration = currentHost.hydration();
  hydration.asset_data = await buildLiveAssetData(hole.hole_id);
  startRabbithole(hydration, {
    transport: currentHost.adapter(),
    exportPortable: exportCurrentRabbithole,
  });

  document.getElementById("web-home").addEventListener("click", async () => {
    await currentHost?.flushSave();
    history.pushState(null, "", location.pathname);
    location.reload();
  });

  window.__rhWebApp = {
    store,
    exportSnapshotForTest: async () => buildSnapshotHtml(await buildSnapshotHydration()),
    exportSnapshotJsonForTest: async () => buildSnapshotJson(await buildSnapshotHydration()),
    exportRabbitholeForTest: async (id = currentHoleId) => {
      await currentHost?.flushSave();
      return downloadRabbitholeExport(store, id);
    },
    importRabbitholeForTest: (text) => importRabbitholeFile(store, text),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => store.readRawHoleForTest(id),
  };
}

async function exportCurrentRabbithole() {
  await currentHost?.flushSave();
  if (!currentHoleId) throw new Error("No open Rabbithole to export.");
  const payload = await downloadRabbitholeExport(store, currentHoleId);
  return { filename: rabbitholeFilename(payload.hole?.title), payload };
}

function initCanvasSettings() {
  const modal = document.getElementById("web-settings-modal");
  const open = document.getElementById("web-settings");
  const close = document.getElementById("web-settings-close");
  let releaseTrap = null;
  initSettingsPanel();
  const closeModal = () => {
    modal.hidden = true;
    if (releaseTrap) {
      releaseTrap();
      releaseTrap = null;
    }
  };
  open.addEventListener("click", () => {
    modal.hidden = false;
    if (releaseTrap) releaseTrap();
    releaseTrap = activateFocusTrap(modal, {
      initialFocus: modal.querySelector("select, input, button"),
      onEscape: closeModal,
    });
  });
  close.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const settings = loadSettings();
  const presetOptions = Object.values(BRAIN_PRESETS).map((preset) => {
    const label = preset.recommended ? `${preset.label} (recommended)` : preset.label;
    return `<option value="${preset.id}" ${settings.preset === preset.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  panel.dataset.preset = presetFor(settings.preset).id;
  panel.innerHTML = `<div class="settings-inner">
    <div class="settings-head">
      <div>
        <h2>Provider settings</h2>
        <p>Connect the model Rabbithole uses when you ask from a selection.</p>
      </div>
    </div>
    <div class="settings-basic">
      <label class="field provider-field" for="provider-preset">
        <span>Provider</span>
        <select id="provider-preset">${presetOptions}</select>
      </label>
      <label class="field custom-only" for="provider-base">
        <span>Base URL</span>
        <input id="provider-base" value="${escapeAttr(settings.base_url || "")}" placeholder="http://localhost:11434/v1">
      </label>
      <div class="field key-field">
        <label for="api-key">API key</label>
        <div class="secret-input">
          <input id="api-key" type="password" autocomplete="off" placeholder="${escapeAttr(apiKeyPlaceholder(settings.preset))}" value="${escapeAttr(getApiKey(settings))}">
          <button id="api-key-toggle" class="web-secondary" type="button" aria-label="Show API key" aria-pressed="false">Show</button>
        </div>
      </div>
      <label class="switch-field" for="session-only">
        <input id="session-only" type="checkbox" role="switch" ${settings.session_only !== false ? "checked" : ""}>
        <span class="switch-track" aria-hidden="true"></span>
        <span class="switch-copy"><strong>Session only</strong><small>Keep this key in memory for this tab.</small></span>
      </label>
    </div>
    <details class="settings-advanced">
      <summary>Advanced</summary>
      <div class="settings-advanced-grid">
        <label class="field" for="answer-model">
          <span>Answer model</span>
          <input id="answer-model" value="${escapeAttr(settings.answer_model || "")}">
          <small class="model-hint" data-model-hint="answer">${escapeHtml(testedModelHint(settings.answer_model || presetFor(settings.preset).answer_model))}</small>
        </label>
        <label class="field" for="author-model">
          <span>Author model</span>
          <input id="author-model" value="${escapeAttr(settings.author_model || "")}">
          <small class="model-hint" data-model-hint="author">${escapeHtml(testedModelHint(settings.author_model || presetFor(settings.preset).author_model))}</small>
        </label>
        <label class="field wide-field" for="fetch-proxy-url">
          <span>Fetch proxy URL</span>
          <input id="fetch-proxy-url" value="${escapeAttr(settings.fetch_proxy_url || "")}" placeholder="https://your-worker.example/?url=">
        </label>
        <p class="custom-csp-note wide-field">Custom remote origins require editing this static app's CSP. Localhost custom endpoints are allowed by default.</p>
      </div>
    </details>
    <div class="settings-actions">
      <a class="key-walkthrough" href="${OPENROUTER_WALKTHROUGH_URL}" target="_blank" rel="noreferrer">30-second OpenRouter key walkthrough</a>
      <button id="save-settings" class="web-primary" type="button">Save settings</button>
    </div>
  </div>`;

  panel.querySelector("#provider-preset").addEventListener("change", (event) => {
    const next = settingsForPreset(event.target.value, readSettingsForm());
    panel.dataset.preset = next.preset;
    panel.querySelector("#provider-base").value = next.base_url;
    panel.querySelector("#answer-model").value = next.answer_model;
    panel.querySelector("#author-model").value = next.author_model;
    panel.querySelector("#api-key").placeholder = apiKeyPlaceholder(next.preset);
    updateModelHints(panel);
  });
  panel.querySelector("#answer-model").addEventListener("input", () => updateModelHints(panel));
  panel.querySelector("#author-model").addEventListener("input", () => updateModelHints(panel));
  panel.querySelector("#api-key-toggle").addEventListener("click", () => {
    const input = panel.querySelector("#api-key");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    const button = panel.querySelector("#api-key-toggle");
    button.textContent = showing ? "Show" : "Hide";
    button.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
    button.setAttribute("aria-pressed", showing ? "false" : "true");
  });
  panel.querySelector("#save-settings").addEventListener("click", () => {
    const next = readSettingsForm();
    saveSettings(next);
    showToast({ message: "Settings saved." });
    panel.classList.toggle("needs-key", presetFor(next.preset).requires_key && !getApiKey(next));
    if (currentHost) {
      const key = getApiKey(next);
      currentHost.brain = key || !presetFor(next.preset).requires_key ? createBrain(next, key) : null;
    }
  });
  updateModelHints(panel);
}

function updateModelHints(panel = document.getElementById("settings-panel")) {
  if (!panel) return;
  const answer = panel.querySelector("#answer-model")?.value || "";
  const author = panel.querySelector("#author-model")?.value || "";
  const answerHint = panel.querySelector("[data-model-hint='answer']");
  const authorHint = panel.querySelector("[data-model-hint='author']");
  if (answerHint) answerHint.textContent = testedModelHint(answer);
  if (authorHint) authorHint.textContent = testedModelHint(author);
}

function readSettingsForm() {
  const sessionOnly = document.getElementById("session-only")?.checked !== false;
  return {
    preset: document.getElementById("provider-preset")?.value || "openrouter",
    base_url: document.getElementById("provider-base")?.value.trim() || "",
    author_model: document.getElementById("author-model")?.value.trim() || "",
    answer_model: document.getElementById("answer-model")?.value.trim() || "",
    fetch_proxy_url: document.getElementById("fetch-proxy-url")?.value.trim() || "",
    session_only: sessionOnly,
    api_key: document.getElementById("api-key")?.value || "",
  };
}

function loadSettings() {
  const defaults = defaultWebSettings();
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
  } catch {
    return defaults;
  }
}

function defaultWebSettings() {
  return { ...defaultBrainSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

function saveSettings(settings) {
  const { api_key, ...persistable } = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  if (settings.session_only === false) {
    localStorage.setItem(KEY_KEY, api_key || "");
    memoryKey = "";
  } else {
    localStorage.removeItem(KEY_KEY);
    memoryKey = api_key || "";
  }
}

function getApiKey(settings) {
  if (settings.session_only === false) {
    try { return localStorage.getItem(KEY_KEY) || ""; } catch { return ""; }
  }
  return memoryKey;
}

async function buildLiveAssetData(holeId) {
  const out = {};
  for (const name of await store.listAssets(holeId)) {
    const blob = await store.getAsset(holeId, name);
    if (blob) out[name] = URL.createObjectURL(blob);
  }
  return out;
}

function showToast({ message, actionLabel = "", timeoutMs = 4000, onAction = null } = {}) {
  const el = document.getElementById("web-toast");
  if (!el) return;
  el.innerHTML = `<span>${escapeHtml(message || "")}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ""}`;
  el.classList.add("visible");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.classList.remove("visible");
  };
  const timer = setTimeout(finish, timeoutMs);
  const button = el.querySelector("button");
  if (button) {
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      await onAction?.();
      finish();
    }, { once: true });
  }
}

function setIngestStatus(message, tone = "") {
  const el = document.getElementById("ingest-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `ingest-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
  el.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
}

function isPdfFile(file) {
  return /(\.pdf$|application\/pdf)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isRabbitholeFile(file) {
  return /\.rabbithole$/i.test(file?.name || "");
}

function isSessionJsonFile(file) {
  return /(\.json$|application\/json)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isMarkdownFile(file) {
  return /(\.md$|\.markdown$|markdown|text\/plain)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function holeIdFromHash() {
  const match = /^#hole=(.+)$/.exec(location.hash || "");
  return match ? decodeURIComponent(match[1]) : "";
}

function formatRelativeDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Updated at an unknown time";
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const ranges = [
    [60, "second", 1],
    [60 * 60, "minute", 60],
    [60 * 60 * 24, "hour", 60 * 60],
    [60 * 60 * 24 * 30, "day", 60 * 60 * 24],
    [60 * 60 * 24 * 365, "month", 60 * 60 * 24 * 30],
    [Infinity, "year", 60 * 60 * 24 * 365],
  ];
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const [, unit, divisor] = ranges.find(([limit]) => abs < limit);
    return `Updated ${formatter.format(Math.round(deltaSeconds / divisor), unit)}`;
  } catch {
    return `Updated ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
}

function blobToDataUrl(blob) {
  if (!blob) return Promise.resolve("data:,");
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "data:,"));
    reader.onerror = () => resolve("data:,");
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function applyInitialWebTheme() {
  try {
    let savedTheme = localStorage.getItem("rh-theme");
    if (savedTheme !== "dark" && savedTheme !== "light") savedTheme = "";
    if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch {}
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopyText(text);
  }
  showToast({ message });
}

function fallbackCopyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-999px";
  document.body.append(area);
  area.select();
  try { document.execCommand("copy"); } catch {}
  area.remove();
}

function apiKeyPlaceholder(presetId) {
  switch (presetFor(presetId).id) {
    case "openrouter": return "sk-or-v1-...";
    case "anthropic": return "sk-ant-...";
    case "openai": return "sk-...";
    default: return "optional";
  }
}

function bunnyMarkSvg() {
  return `<svg width="24" height="24" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    <ellipse cx="30" cy="17" rx="4.6" ry="12.5" transform="rotate(20 30 17)"></ellipse>
    <ellipse cx="21.5" cy="15.5" rx="4.6" ry="13" transform="rotate(3 21.5 15.5)"></ellipse>
    <circle cx="21" cy="33" r="9.5"></circle>
    <ellipse cx="36" cy="45" rx="17" ry="13.5"></ellipse>
    <circle cx="52.5" cy="49" r="5"></circle>
  </svg>`;
}
