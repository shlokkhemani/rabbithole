import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, providerFor, settingsForProvider, PROVIDERS } from "./brain/index.js";
import { ensureCanonical, loadSettings, saveSettings } from "./settings/preferences-store.js";
import { getApiKey } from "./settings/credential-store.js";
import { installTestSeam } from "./test-seam.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, createPendingHoleFromQuestion } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { activateFocusTrap } from "../ui/focus-trap.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml } from "../ui/snapshot.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { downloadRabbitholeExport, importRabbitholeFile, rabbitholeFilename } from "./portable.js";
import { testedModelHint } from "./brain/tested-models.js";
import {
  loadModelCatalog,
  searchModels,
  formatModelPrice,
  prettyModelId,
  SUGGESTED_MODEL_IDS,
  RECOMMENDED_MODEL_ID,
} from "./brain/model-catalog.js";

const LAST_HOLE_KEY = "rh-last-hole";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const OPENROUTER_KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";

const store = new IdbStore();
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;
let railOpen = false;
let blankZoom = 1;
let composerTrap = null;
let settingsTrap = null;
let composerPath = "";
let pendingComposerAction = null;
let pendingBranchRetry = null;
let lastHoleCount = 0;
let modelCatalogCache = null;
let closeSettingsPickerFn = null;
let settingsKeyToken = 0;

ensureCanonical();
applyInitialWebTheme();

boot().catch((err) => {
  document.body.innerHTML = `<main class="web-fatal"><h1>Rabbithole</h1><p>${escapeHtml(err?.message || String(err))}</p></main>`;
});

async function boot() {
  document.body.classList.add("web-app");
  renderShell();
  initAppChrome();
  initComposer();
  initSettingsModal();
  initGlobalDrops();

  const initial = await chooseInitialHole();
  await renderRail();
  if (initial) {
    await startHole(initial, { replace: true });
  } else {
    showBlankCanvas({ openComposer: true });
  }
  exposeTestApi();
  installTestSeam({
    store,
    currentHoleId: () => currentHoleId,
    createDocument: createFromComposerDocument,
    exportSnapshot: async () => buildSnapshotHtml(await buildSnapshotHydration()),
  });
}

function renderShell() {
  document.documentElement.classList.remove("web-home-active");
  document.documentElement.classList.add("web-canvas-active");
  document.body.classList.add("mode-canvas", "web-shell");
  document.body.innerHTML = `<div id="canvas-root">${CANVAS_SHELL}</div>
    <aside id="web-rail" class="web-rail" aria-label="Rabbitholes" tabindex="-1"></aside>
    <div id="composer-modal" class="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title" hidden>
      <div class="composer-card" id="composer-card" tabindex="-1">
        <section id="composer-start" class="composer-start">
          <header class="composer-start-head">
            <span class="composer-title-mark" aria-hidden="true">${bunnyMarkSvg()}</span>
            <h1 id="composer-title">Enter a Rabbithole</h1>
          </header>
          <div class="composer-paths" role="group" aria-label="Choose how to begin">
            <button class="composer-path" id="composer-path-ask" type="button" data-path="ask">
              <span class="composer-path-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M5.25 6.6A3.75 3.75 0 0 1 9 3a3.5 3.5 0 0 1 3.75 3.35c0 2.25-2.35 2.65-3.2 4.05-.25.4-.3.75-.3 1.1"/><path d="M9.25 14.5h.01"/></svg></span>
              <span class="composer-path-copy"><strong>Ask a question</strong><small>Start with something you want to understand.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
            <button class="composer-path" id="composer-path-file" type="button" data-path="file">
              <span class="composer-path-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M5 2.75h5l3 3v9.5H5z"/><path d="M10 2.75v3h3"/><path d="M7.25 9h3.5M7.25 11.75h3.5"/></svg></span>
              <span class="composer-path-copy"><strong>Open PDF or Markdown</strong><small>Bring in a document from your device.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
            <button class="composer-path" id="composer-path-url" type="button" data-path="url">
              <span class="composer-path-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m7.15 10.85 3.7-3.7"/><path d="M6.05 12.95 4.9 14.1a2.85 2.85 0 0 1-4-4L3.8 7.2a2.85 2.85 0 0 1 4 0" transform="translate(2 0)"/><path d="m9.95 5.05 1.15-1.15a2.85 2.85 0 0 1 4 4l-2.9 2.9a2.85 2.85 0 0 1-4 0"/></svg></span>
              <span class="composer-path-copy"><strong>Add a link</strong><small>Open an article or paper from the web.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>
        <section id="composer-entry" class="composer-entry" hidden>
          <button id="composer-back" class="composer-back" type="button"><span aria-hidden="true">←</span> All options</button>
          <header class="composer-entry-head">
            <h2 id="composer-entry-title"></h2>
            <p id="composer-entry-copy"></p>
          </header>
          <textarea id="composer-input" rows="1" autocomplete="off" spellcheck="true"></textarea>
          <div class="composer-entry-actions">
            <button id="composer-primary" class="web-primary" type="button"></button>
          </div>
        </section>
        <input id="file-md" type="file" accept=".md,.markdown,.pdf,.rabbithole,text/markdown,text/plain,application/pdf,application/json" hidden>
        <div id="composer-key-panel" class="inline-key-slot" hidden></div>
        <div id="ingest-status" class="ingest-status" aria-live="polite" aria-atomic="true"></div>
      </div>
    </div>
    <div id="blank-start" class="blank-start" hidden>
      <button id="blank-start-new" class="blank-start-new" type="button">
        <svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/></svg>
        New Rabbithole
        <kbd>N</kbd>
      </button>
      <p class="blank-start-sub">or drop a PDF or Markdown file anywhere</p>
    </div>
    <div id="web-settings-modal" class="web-settings-modal" role="dialog" aria-modal="true" aria-label="Model settings" hidden>
      <div class="web-settings-dialog" tabindex="-1">
        <div id="settings-inline-key" class="settings-inline-key" hidden></div>
        <section id="settings-panel" class="settings-panel" aria-label="Model settings"></section>
      </div>
    </div>
    <div id="web-toast" class="web-toast" aria-live="polite"></div>`;
  document.getElementById("toolbar")?.insertAdjacentHTML("afterbegin",
    `<span class="toolbar-brand" title="Rabbithole" aria-label="Rabbithole">${bunnyMarkSvg()}</span><span class="sep toolbar-brand-sep"></span>`);
  railOpen = loadRailOpen();
  applyRailState();
  syncRailPosition();
  requestAnimationFrame(syncRailPosition);
}

async function chooseInitialHole() {
  const hashHole = holeIdFromHash();
  if (hashHole) {
    const hole = await store.loadHole(hashHole);
    if (hole) return hole;
  }
  const storedId = safeLocalStorageGet(LAST_HOLE_KEY);
  if (storedId && storedId !== hashHole) {
    const stored = await store.loadHole(storedId);
    if (stored) return stored;
  }
  const holes = await store.listHoles();
  lastHoleCount = holes.length;
  if (!holes.length) return null;
  return store.loadHole(holes[0].hole_id);
}

function initAppChrome() {
  const rail = document.getElementById("web-rail");
  window.addEventListener("resize", syncRailPosition, { passive: true });
  window.addEventListener("resize", syncSettingsPosition, { passive: true });
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", () => openComposer({ source: "button" }));
  document.getElementById("t-settings")?.addEventListener("click", () => openSettingsModal());
  document.getElementById("blank-start-new")?.addEventListener("click", () => openComposer({ source: "button" }));
  rail?.addEventListener("click", async (event) => {
    const row = event.target?.closest?.(".rail-row");
    if (!row) return;
    const id = row.dataset.hole;
    if (event.target.closest(".rail-delete")) {
      event.preventDefault();
      event.stopPropagation();
      await deleteHoleFromRail(id);
      return;
    }
    if (event.target.closest(".rail-export")) {
      event.preventDefault();
      event.stopPropagation();
      await exportHoleFromRail(id);
      return;
    }
    if (event.target.closest(".rail-open")) {
      event.preventDefault();
      if (!id || id === currentHoleId) return;
      await currentHost?.flushSave();
      const hole = await store.loadHole(id);
      if (hole) await startHole(hole);
    }
  });
  document.getElementById("t-theme")?.addEventListener("click", () => {
    if (currentHoleId) return;
    toggleBlankTheme();
  });
  document.getElementById("t-zin")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(blankZoom * 1.15);
  });
  document.getElementById("t-zout")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(blankZoom * 0.87);
  });
  document.getElementById("zoom-label")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(1);
  });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      openComposer({ source: "keyboard" });
    } else if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      toggleRail();
    }
  });
}

function initComposer() {
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const primary = document.getElementById("composer-primary");
  const fileInput = document.getElementById("file-md");

  input.addEventListener("input", () => {
    autoGrowTextarea(input, 240);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runComposer();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
    }
  });
  primary.addEventListener("click", runComposer);
  document.getElementById("composer-back").addEventListener("click", showComposerStart);
  document.getElementById("composer-path-ask").addEventListener("click", () => selectComposerPath("ask"));
  document.getElementById("composer-path-url").addEventListener("click", () => selectComposerPath("url"));
  document.getElementById("composer-path-file").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await createFromFile(file);
    fileInput.value = "";
  });
  for (const type of ["dragenter", "dragover"]) {
    modal.addEventListener(type, (event) => {
      event.preventDefault();
      modal.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    modal.addEventListener(type, (event) => {
      event.preventDefault();
      modal.classList.remove("dragging");
    });
  }
  modal.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeComposer();
  });
}

function initGlobalDrops() {
  const viewport = document.getElementById("viewport");
  for (const type of ["dragenter", "dragover"]) {
    viewport.addEventListener(type, (event) => {
      if (currentHoleId || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      document.body.classList.add("blank-dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    viewport.addEventListener(type, (event) => {
      if (currentHoleId) return;
      event.preventDefault();
      document.body.classList.remove("blank-dragging");
    });
  }
  viewport.addEventListener("drop", async (event) => {
    if (currentHoleId) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    openComposer({ source: "drop" });
    await createFromFile(file);
  });
}

function openComposer({ source = "button", value = "" } = {}) {
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const card = document.getElementById("composer-card");

  pendingComposerAction = null;
  composerPath = "";
  setIngestStatus("");
  clearComposerKeyPanel();
  document.getElementById("composer-start").hidden = false;
  document.getElementById("composer-entry").hidden = true;
  input.value = value;
  autoGrowTextarea(input, 240);
  modal.hidden = false;
  document.getElementById("blank-start").hidden = true;
  if (value) selectComposerPath(isSingleHttpUrl(value) ? "url" : "ask", { value });
  if (composerTrap) composerTrap();
  // Focus rests on the card, not the first option — nothing looks preselected.
  composerTrap = activateFocusTrap(modal, {
    initialFocus: value ? input : card,
    onEscape: closeComposer,
  });
  (value ? input : card).focus({ preventScroll: true });
}

function closeComposer() {
  const modal = document.getElementById("composer-modal");
  modal.hidden = true;
  modal.classList.remove("dragging");
  pendingComposerAction = null;
  clearComposerKeyPanel();
  if (composerTrap) {
    composerTrap();
    composerTrap = null;
  }
  if (!currentHoleId && lastHoleCount === 0) {
    document.getElementById("blank-start").hidden = false;
  }
}

function selectComposerPath(path, { value = "" } = {}) {
  if (path !== "ask" && path !== "url") return;
  composerPath = path;
  const input = document.getElementById("composer-input");
  const isAsk = path === "ask";
  document.getElementById("composer-start").hidden = true;
  document.getElementById("composer-entry").hidden = false;
  document.getElementById("composer-card").dataset.path = path;
  document.getElementById("composer-entry-title").textContent = isAsk ? "Ask a question" : "Add a link";
  document.getElementById("composer-entry-copy").textContent = isAsk
    ? "What would you like to understand?"
    : "Paste a link to a paper or article. arXiv links work best.";
  input.placeholder = isAsk ? "Type your question…" : "https://…";
  input.spellcheck = isAsk;
  input.value = value;
  document.getElementById("composer-primary").textContent = isAsk ? "Start exploring" : "Open link";
  autoGrowTextarea(input, 240);
  input.focus({ preventScroll: true });
}

function showComposerStart() {
  composerPath = "";
  setIngestStatus("");
  clearComposerKeyPanel();
  document.getElementById("composer-card").removeAttribute("data-path");
  document.getElementById("composer-entry").hidden = true;
  document.getElementById("composer-start").hidden = false;
  document.getElementById("composer-input").value = "";
  document.getElementById("composer-card").focus({ preventScroll: true });
}

async function runComposer() {
  const input = document.getElementById("composer-input");
  const value = input.value.trim();
  if (composerPath === "url") return createFromUrl(value);
  if (composerPath === "ask") return createFromAsk(value);
}

async function createFromComposerDocument(markdown, { improveStructure = false } = {}) {
  if (!markdown) {
    setIngestStatus("Paste a document first.", "error");
    return;
  }
  const action = () => createFromComposerDocument(markdown, { improveStructure });
  if (improveStructure && !(await ensureKeyForComposerAction(action))) return;
  try {
    const authored = await maybeAuthorMarkdown({
      title: "",
      markdown,
      sourceName: "pasted text",
      kind: "paste",
      improveStructure,
    });
    const hole = createHoleFromMarkdown({ title: "", markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Document import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromAsk(question) {
  if (!question) {
    setIngestStatus("Ask a question first.", "error");
    return;
  }
  const action = () => createFromAsk(question);
  if (!(await ensureKeyForComposerAction(action))) return;

  try {
    const hole = createPendingHoleFromQuestion(question);
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    const message = err?.message || String(err);
    if (isAuthLikeError(err)) {
      showComposerKeyPanel({
        title: err?.code === "missing_key" ? "" : "Update your key",
        status: err?.code === "missing_key" ? "" : message,
        afterValidated: action,
      });
    } else {
      setIngestStatus(`Ask failed. ${message}`, "error");
    }
  }
}

async function createFromUrl(rawUrl) {
  if (!rawUrl) {
    setIngestStatus("Enter a URL first.", "error");
    return;
  }
  try {
    const settings = loadSettings();
    setIngestStatus("Fetching URL...", "busy");
    const { hole } = await openUrlToStoredHole({
      rawUrl,
      store,
      title: "",
      proxyBaseUrl: settings.fetch_proxy_url || "",
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

async function createFromFile(file) {
  if (isRabbitholeFile(file)) return createFromRabbitholeFile(file);
  if (isPdfFile(file)) return createFromPdfFile(file);
  if (!isMarkdownFile(file)) {
    setIngestStatus("Choose a markdown, PDF, or .rabbithole file.", "error");
    return;
  }
  try {
    setIngestStatus("Reading markdown file...", "busy");
    const markdown = await file.text();
    const authored = await maybeAuthorMarkdown({
      title: file.name.replace(/\.[^.]+$/, ""),
      markdown,
      sourceName: file.name,
      kind: "file",
    });
    const hole = createHoleFromMarkdown({ title: "", markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Markdown import failed. ${err?.message || String(err)}`, "error");
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
    const { hole } = await ingestPdfToStoredHole({
      source: file,
      store,
      title: "",
      onProgress: ({ page, index, total }) => {
        if (page) setIngestStatus(`Importing PDF page ${index}/${total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`PDF import failed. ${err?.message || String(err)} Try a different PDF.`, "error");
  }
}

async function maybeAuthorMarkdown({
  title = "",
  markdown = "",
  sourceName = "",
  kind = "source",
  baseUrl = "",
  improveStructure = false,
} = {}) {
  if (!improveStructure) return markdown;
  const settings = loadSettings();
  const key = getApiKey(settings);
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

async function ensureKeyForComposerAction(action) {
  const settings = loadSettings();
  const preset = providerFor(settings.preset);
  if (!preset.requires_key || getApiKey(settings)) return true;
  pendingComposerAction = action;
  showComposerKeyPanel({ afterValidated: action });
  return false;
}

function showComposerKeyPanel({ title = "", status = "", afterValidated = null } = {}) {
  const slot = document.getElementById("composer-key-panel");
  slot.hidden = false;
  renderInlineKeyPanel(slot, {
    idPrefix: "composer",
    title,
    status,
    afterValidated: async () => {
      slot.hidden = true;
      pendingComposerAction = null;
      await afterValidated?.();
    },
  });
}

function clearComposerKeyPanel() {
  const slot = document.getElementById("composer-key-panel");
  if (slot) {
    slot.hidden = true;
    slot.innerHTML = "";
  }
}

async function startHole(hole, { replace = false } = {}) {
  if (uiStarted) {
    await currentHost?.flushSave();
    location.hash = `hole=${encodeURIComponent(hole.hole_id)}`;
    location.reload();
    return;
  }
  uiStarted = true;
  currentHoleId = hole.hole_id;
  currentHost = null;
  document.body.classList.remove("web-blank-canvas");
  document.getElementById("blank-start").hidden = true;
  closeComposerSilently();
  safeLocalStorageSet(LAST_HOLE_KEY, hole.hole_id);
  if (replace) history.replaceState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);
  else history.pushState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);

  setSnapshotHooks({
    fetchAssetData: async (name) => blobToDataUrl(await store.getAsset(currentHoleId, name)),
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
  });

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  currentHost = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    onToast: showToast,
    onDone: async () => {
      await currentHost?.flushSave();
      history.replaceState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => location.reload(),
    onAuthRequired: handleBranchAuthRequired,
    onRootAnswered: renderRail,
  });

  const hydration = currentHost.hydration();
  hydration.asset_data = await buildLiveAssetData(hole.hole_id);
  startRabbithole(hydration, {
    transport: currentHost.adapter(),
    exportPortable: exportCurrentRabbithole,
  });
  document.getElementById("r-canvas")?.click();
  await renderRail();
  exposeTestApi();
  currentHost.startRootAnswer();
}

function closeComposerSilently() {
  const modal = document.getElementById("composer-modal");
  if (modal) modal.hidden = true;
  if (composerTrap) {
    composerTrap();
    composerTrap = null;
  }
}

function showBlankCanvas({ openComposer: shouldOpenComposer = false } = {}) {
  uiStarted = false;
  currentHost = null;
  currentHoleId = null;
  document.body.classList.add("mode-canvas", "web-blank-canvas");
  document.getElementById("world").innerHTML = `<svg id="edges"></svg>`;
  setBlankZoom(1);
  history.replaceState(null, "", location.pathname);
  if (shouldOpenComposer) openComposer({ source: "empty" });
}

async function exportCurrentRabbithole() {
  await currentHost?.flushSave();
  if (!currentHoleId) throw new Error("No open Rabbithole to export.");
  const payload = await downloadRabbitholeExport(store, currentHoleId);
  return { filename: rabbitholeFilename(payload.hole?.title), payload };
}

async function renderRail() {
  const rail = document.getElementById("web-rail");
  if (!rail) return;
  const summaries = await store.listHoles();
  lastHoleCount = summaries.length;
  rail.innerHTML = `<div class="rail-inner">
    <div class="rail-list" id="rail-list">
      ${summaries.length ? summaries.map((summary) => railRowHtml(summary)).join("") : `<div class="rail-empty">No Rabbitholes yet.</div>`}
    </div>
  </div>`;
  rail.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // Contain Escape to the rail: the canvas client's document-level
      // handler treats a loose Escape as "open the reader".
      event.stopPropagation();
      setRailOpen(false);
    }
  });
  applyRailState();
}

function railRowHtml(summary) {
  const title = summary.title || "Untitled";
  const updated = formatRelativeDate(summary.updated_at);
  return `<article class="rail-row${summary.hole_id === currentHoleId ? " current" : ""}" data-hole="${escapeAttr(summary.hole_id)}">
    <button class="rail-open" type="button" aria-label="${escapeAttr(title)}" title="${escapeAttr(updated)}">
      <span class="rail-row-copy">
        <span class="rail-title">${escapeHtml(title)}</span>
      </span>
    </button>
    <span class="rail-actions">
      <button class="rail-icon rail-export" type="button" aria-label="Export ${escapeAttr(title)}"><svg width="15" height="15" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M8 2.75v7"/><path d="M5.25 7.1 8 9.85l2.75-2.75"/><path d="M3.25 12.75h9.5"/></svg></button>
      <button class="rail-icon rail-delete" type="button" aria-label="Delete ${escapeAttr(title)}"><svg width="15" height="15" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M3.25 4.25h9.5"/><path d="M6.25 2.75h3.5"/><path d="M5.25 4.25v8.25h5.5V4.25"/><path d="M7 6.5v3.75"/><path d="M9 6.5v3.75"/></svg></button>
    </span>
  </article>`;
}

async function deleteHoleFromRail(holeId) {
  if (!holeId) return;
  const deletingCurrent = holeId === currentHoleId;
  if (deletingCurrent) {
    await currentHost?.flushSave();
    currentHost?.dispose?.();
    currentHost = null;
  }
  const hole = await store.loadHole(holeId);
  if (!hole) return;
  const assets = [];
  for (const name of await store.listAssets(holeId)) {
    assets.push({ name, blob: await store.getAsset(holeId, name) });
  }
  await store.deleteHole(holeId);
  if (safeLocalStorageGet(LAST_HOLE_KEY) === holeId) localStorage.removeItem(LAST_HOLE_KEY);
  await renderRail();
  showToast({
    message: `Deleted "${hole.title || "Untitled"}"`,
    actionLabel: "Undo",
    timeoutMs: 10000,
    onAction: async () => {
      await store.saveHole(hole);
      for (const asset of assets) {
        if (asset.blob) await store.putAsset(holeId, asset.name, asset.blob);
      }
      await renderRail();
    },
  });
  if (deletingCurrent) {
    const next = (await store.listHoles())[0];
    if (next) {
      const nextHole = await store.loadHole(next.hole_id);
      if (nextHole) await startHole(nextHole, { replace: true });
    } else {
      location.hash = "";
      location.reload();
    }
  }
}

async function exportHoleFromRail(holeId) {
  try {
    if (holeId === currentHoleId) await currentHost?.flushSave();
    const payload = await downloadRabbitholeExport(store, holeId);
    showToast({ message: `Exported ${rabbitholeFilename(payload.hole?.title)}.` });
  } catch (err) {
    showToast({ message: err?.message || String(err) });
  }
}

function toggleRail() {
  setRailOpen(!railOpen);
}

function syncRailPosition() {
  const rail = document.getElementById("web-rail");
  const toolbar = document.getElementById("toolbar");
  if (!rail || !toolbar) return;
  rail.style.setProperty("--rail-top", `${toolbar.getBoundingClientRect().bottom + 14}px`);
}

function syncSettingsPosition() {
  const modal = document.getElementById("web-settings-modal");
  const dialog = modal?.querySelector(".web-settings-dialog");
  const button = document.getElementById("t-settings");
  if (!modal || modal.hidden || !dialog || !button) return;

  const edge = window.innerWidth <= 760 ? 8 : 14;
  const toolbarRect = document.getElementById("toolbar")?.getBoundingClientRect();
  const readerRect = document.getElementById("reader-top")?.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const dialogWidth = dialog.offsetWidth || Math.min(340, window.innerWidth - edge * 2);
  const anchorBottom = toolbarRect?.height ? toolbarRect.bottom : (readerRect?.height ? readerRect.bottom : 0);
  const anchorRight = buttonRect.width ? buttonRect.right : window.innerWidth - edge;
  const left = Math.max(edge, Math.min(window.innerWidth - dialogWidth - edge, anchorRight - dialogWidth));

  modal.style.setProperty("--settings-left", `${left}px`);
  modal.style.setProperty("--settings-top", `${anchorBottom + edge}px`);
  modal.style.setProperty("--settings-edge", `${edge}px`);
}

function setRailOpen(value) {
  railOpen = !!value;
  applyRailState();
  if (railOpen) document.getElementById("web-rail")?.focus({ preventScroll: true });
}

function applyRailState() {
  document.body.classList.toggle("rail-open", railOpen);
  const rail = document.getElementById("web-rail");
  const toggle = document.getElementById("t-rail");
  if (rail) rail.classList.toggle("open", railOpen);
  if (toggle) {
    toggle.setAttribute("aria-expanded", railOpen ? "true" : "false");
    toggle.classList.toggle("rail-on", railOpen);
  }
}

function loadRailOpen() {
  return false;
}

function initSettingsModal() {
  initSettingsPanel();
  const modal = document.getElementById("web-settings-modal");
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeSettingsModal();
  });
}

function openSettingsModal({ focusKey = false, focusSelector = "" } = {}) {
  const modal = document.getElementById("web-settings-modal");
  initSettingsPanel();
  modal.hidden = false;
  syncSettingsPosition();
  requestAnimationFrame(syncSettingsPosition);
  document.getElementById("t-settings")?.setAttribute("aria-expanded", "true");
  warmModelCatalog();
  const panel = document.getElementById("settings-panel");
  if (panel?.querySelector("#api-key")?.value.trim()) commitSettingsKey(panel);
  if (settingsTrap) settingsTrap();
  const explicitFocus = focusSelector ? modal.querySelector(focusSelector) : null;
  settingsTrap = activateFocusTrap(modal, {
    initialFocus: explicitFocus || (focusKey ? modal.querySelector("#api-key") : modal.querySelector(".web-settings-dialog")),
    onEscape: () => {
      if (closeSettingsPickerFn) {
        closeSettingsPickerFn();
        return;
      }
      closeSettingsModal();
    },
  });
}

function closeSettingsModal() {
  const modal = document.getElementById("web-settings-modal");
  modal.hidden = true;
  document.getElementById("t-settings")?.setAttribute("aria-expanded", "false");
  const inline = document.getElementById("settings-inline-key");
  inline.hidden = true;
  inline.innerHTML = "";
  pendingBranchRetry = null;
  closeSettingsPickerFn = null;
  if (settingsTrap) {
    settingsTrap();
    settingsTrap = null;
  }
}

function warmModelCatalog() {
  const settings = loadSettings();
  if (providerFor(settings.preset).model_source !== "catalog") return;
  loadModelCatalog().then((models) => {
    modelCatalogCache = models;
    const nameEl = document.getElementById("model-select-name");
    if (nameEl) {
      const current = loadSettings();
      nameEl.textContent = modelDisplayName(current.answer_model || providerFor(current.preset).answer_model);
    }
  }).catch(() => {});
}

function modelDisplayName(id) {
  const hit = modelCatalogCache?.find((model) => model.id === id);
  return hit ? hit.name : prettyModelId(id);
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  if (!panel) return;
  closeSettingsPickerFn = null;
  const settings = loadSettings();
  const preset = providerFor(settings.preset);
  const currentModel = settings.answer_model || preset.answer_model;
  const providerOptions = Object.values(PROVIDERS).map((provider) =>
    `<option value="${escapeAttr(provider.id)}" ${provider.id === preset.id ? "selected" : ""}>${escapeHtml(provider.label)}</option>`
  ).join("");
  panel.dataset.preset = preset.id;
  panel.innerHTML = `<div class="settings-inner">
    <div class="settings-section provider-section">
      <div class="settings-row">
        <label class="settings-label" for="provider-select">Provider</label>
        <span class="native-select-wrap">
          <select id="provider-select" aria-label="Provider">${providerOptions}</select>
          <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>
        </span>
      </div>
    </div>
    ${preset.id === "custom" ? `<div class="settings-section endpoint-section">
      <label class="field" for="provider-base">
        <span>Endpoint</span>
        <input id="provider-base" value="${escapeAttr(settings.base_url || "")}" placeholder="http://localhost:11434/v1">
        <small class="field-hint">Use an OpenAI-compatible endpoint. Localhost works directly; remote origins require a self-hosted build.</small>
      </label>
    </div>` : ""}
    ${preset.model_source === "catalog" ? `<div class="settings-section model-section">
      <div class="settings-row">
        <span class="settings-label" id="model-select-label">Model</span>
        <button id="model-select" class="settings-select" type="button" aria-haspopup="listbox" aria-expanded="false" title="${escapeAttr(currentModel)}">
          <span id="model-select-name">${escapeHtml(modelDisplayName(currentModel))}</span>
          <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>
        </button>
      </div>
      <div id="model-picker" class="model-picker" hidden>
        <div class="model-search-wrap">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <input id="model-search" placeholder="Search every model on OpenRouter…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="model-list" aria-labelledby="model-select-label">
          <kbd>esc</kbd>
        </div>
        <div id="model-list" class="model-list" role="listbox" aria-labelledby="model-select-label"></div>
      </div>
    </div>` : `<div class="settings-section model-section local-model-section">
      <label class="field" for="local-model">
        <span>Model</span>
        <input id="local-model" value="${escapeAttr(currentModel)}" placeholder="llama3.2" autocomplete="off" spellcheck="false">
        <small class="field-hint">Use the exact name shown by <code>ollama list</code>.</small>
      </label>
    </div>`}
    ${preset.requires_key ? `<div class="settings-section key-section">
      <div class="settings-row key-row">
        <label class="settings-label" for="api-key">${escapeHtml(preset.label)} key</label>
        ${preset.id === "openrouter" ? `<a class="key-get" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key →</a>` : ""}
      </div>
      <div class="key-input-wrap">
        <input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(apiKeyPlaceholder(settings.preset))}" value="${escapeAttr(getApiKey(settings))}">
        <button id="api-key-toggle" type="button" aria-label="Show key" aria-pressed="false">${eyeSvg(false)}</button>
      </div>
      <div id="api-key-status" class="key-status idle visible" aria-live="polite">${escapeHtml(keyIdleWhisper(preset))}</div>
      <label class="settings-row remember-row" for="session-only">
        <span class="switch-copy"><strong>Remember on this device</strong><small>Turn off on shared computers.</small></span>
        <span class="switch" aria-hidden="true">
          <input id="session-only" type="checkbox" role="switch" ${settings.session_only === false ? "checked" : ""}>
          <span class="switch-track"></span>
        </span>
      </label>
    </div>` : ""}
    <details class="settings-advanced">
      <summary>Advanced</summary>
      <div class="settings-advanced-grid">
        <label class="field" for="answer-model">
          <span>Answer model</span>
          <input id="answer-model" value="${escapeAttr(settings.answer_model || "")}">
          <small class="model-hint" data-model-hint="answer">${escapeHtml(testedModelHint(settings.answer_model || preset.answer_model))}</small>
        </label>
        <label class="field" for="author-model">
          <span>Author model</span>
          <input id="author-model" value="${escapeAttr(settings.author_model || "")}">
          <small class="model-hint" data-model-hint="author">${escapeHtml(testedModelHint(settings.author_model || preset.author_model))}</small>
        </label>
        <label class="field" for="fetch-proxy-url">
          <span>Link relay</span>
          <input id="fetch-proxy-url" value="${escapeAttr(settings.fetch_proxy_url || "")}" placeholder="https://your-relay.example/?url=">
          <small class="field-hint">When a site blocks in-browser fetching, links open through this relay instead. It sees only the page URL — never your key or your questions.</small>
        </label>
      </div>
    </details>
  </div>`;
  wireSettingsPanel(panel);
}

function wireSettingsPanel(panel) {
  const keyInput = panel.querySelector("#api-key");
  const status = panel.querySelector("#api-key-status");
  let validateTimer = 0;

  wireProviderSelect(panel);
  wireModelPicker(panel);

  if (keyInput && status) {
    keyInput.addEventListener("input", () => {
      window.clearTimeout(validateTimer);
      validateTimer = window.setTimeout(() => commitSettingsKey(panel), 350);
    });
    keyInput.addEventListener("paste", () => window.setTimeout(() => commitSettingsKey(panel), 0));
    keyInput.addEventListener("blur", () => commitSettingsKey(panel));
    keyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitSettingsKey(panel, { required: true });
      }
    });
    panel.querySelector("#api-key-toggle")?.addEventListener("click", () => toggleKeyReveal(keyInput, panel.querySelector("#api-key-toggle")));
    panel.querySelector("#session-only")?.addEventListener("change", (event) => {
      applySettingsPatch({ session_only: !event.target.checked });
    });
  }
  const liveField = (selector, key) => {
    panel.querySelector(selector)?.addEventListener("change", (event) => {
      applySettingsPatch({ [key]: event.target.value.trim() });
      updateModelHints(panel);
      syncModelSelectLabel(panel);
    });
  };
  liveField("#provider-base", "base_url");
  liveField("#answer-model", "answer_model");
  liveField("#author-model", "author_model");
  liveField("#fetch-proxy-url", "fetch_proxy_url");
  const localModelInput = panel.querySelector("#local-model");
  let localModelTimer = 0;
  const commitLocalModel = () => {
    const model = localModelInput?.value.trim();
    if (!model) return;
    applySettingsPatch({ answer_model: model, author_model: model });
  };
  localModelInput?.addEventListener("input", () => {
    const model = localModelInput.value.trim();
    const answerInput = panel.querySelector("#answer-model");
    const authorInput = panel.querySelector("#author-model");
    if (answerInput) answerInput.value = model;
    if (authorInput) authorInput.value = model;
    updateModelHints(panel);
    window.clearTimeout(localModelTimer);
    localModelTimer = window.setTimeout(commitLocalModel, 180);
  });
  localModelInput?.addEventListener("change", () => {
    window.clearTimeout(localModelTimer);
    commitLocalModel();
  });
  panel.querySelector("#answer-model")?.addEventListener("input", () => updateModelHints(panel));
  panel.querySelector("#author-model")?.addEventListener("input", () => updateModelHints(panel));
  updateModelHints(panel);
}

function wireProviderSelect(panel) {
  const select = panel.querySelector("#provider-select");
  if (!select) return;
  select.addEventListener("change", (event) => {
    const id = event.target.value;
    const current = loadSettings();
    if (!id || id === current.preset) return;
    saveSettings({ ...current, api_key: getApiKey(current) });
    applySettingsPatch(settingsForProvider(id, current));
    initSettingsPanel();
    warmModelCatalog();
    document.getElementById("provider-select")?.focus({ preventScroll: true });
  });
}

function wireModelPicker(panel) {
  const select = panel.querySelector("#model-select");
  const picker = panel.querySelector("#model-picker");
  const search = panel.querySelector("#model-search");
  const list = panel.querySelector("#model-list");
  if (!select || !picker) return;
  let catalogFailed = false;

  const openPicker = () => {
    closeSettingsPickerFn?.({ refocus: false });
    picker.hidden = false;
    select.setAttribute("aria-expanded", "true");
    panel.classList.add("picking");
    search.value = "";
    renderList();
    search.focus({ preventScroll: true });
    closeSettingsPickerFn = closePicker;
    if (!modelCatalogCache) {
      loadModelCatalog().then((models) => {
        modelCatalogCache = models;
        if (!picker.hidden) renderList();
      }).catch(() => {
        catalogFailed = true;
        if (!picker.hidden) renderList();
      });
    }
  };
  const closePicker = ({ refocus = true } = {}) => {
    picker.hidden = true;
    select.setAttribute("aria-expanded", "false");
    panel.classList.remove("picking");
    closeSettingsPickerFn = null;
    if (refocus) select.focus({ preventScroll: true });
  };

  const renderList = () => {
    const settings = loadSettings();
    const current = settings.answer_model || providerFor(settings.preset).answer_model;
    const query = search.value.trim();
    if (!modelCatalogCache) {
      list.innerHTML = catalogFailed
        ? `${query ? customModelRowHtml(query) : ""}<div class="model-note">Couldn't reach OpenRouter for the model list. Type a model id to use it directly.</div>`
        : `<div class="model-note">Loading models…</div>`;
      return;
    }
    let html = "";
    if (!query) {
      const suggested = SUGGESTED_MODEL_IDS
        .map((id) => modelCatalogCache.find((model) => model.id === id))
        .filter(Boolean);
      if (suggested.length) {
        html += `<div class="model-group-label">Suggested</div>`;
        html += suggested.map((model) => modelOptionHtml(model, { current, recommended: model.id === RECOMMENDED_MODEL_ID })).join("");
        html += `<div class="model-group-label">All models</div>`;
      }
      html += modelCatalogCache.map((model) => modelOptionHtml(model, { current })).join("");
    } else {
      const hits = searchModels(modelCatalogCache, query);
      html = hits.map((model) => modelOptionHtml(model, { current })).join("");
      if (!hits.length) html = customModelRowHtml(query);
    }
    list.innerHTML = html;
    list.scrollTop = 0;
    setActiveOption(0);
  };

  const optionRows = () => Array.from(list.querySelectorAll(".model-option"));
  const setActiveOption = (index) => {
    const rows = optionRows();
    rows.forEach((row, i) => row.classList.toggle("active", i === index));
    const active = rows[index];
    if (active) {
      active.scrollIntoView({ block: "nearest" });
      search.setAttribute("aria-activedescendant", active.id || "");
    }
  };
  const activeIndex = () => optionRows().findIndex((row) => row.classList.contains("active"));

  const chooseModel = (id, name) => {
    applySettingsPatch({ author_model: id, answer_model: id });
    const nameEl = panel.querySelector("#model-select-name");
    if (nameEl) nameEl.textContent = name || modelDisplayName(id);
    select.title = id;
    const answerInput = panel.querySelector("#answer-model");
    const authorInput = panel.querySelector("#author-model");
    if (answerInput) answerInput.value = id;
    if (authorInput) authorInput.value = id;
    updateModelHints(panel);
    closePicker();
  };

  select.addEventListener("click", () => {
    if (picker.hidden) openPicker();
    else closePicker();
  });
  search.addEventListener("input", renderList);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
    const rows = optionRows();
    if (!rows.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, activeIndex() + delta));
      setActiveOption(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[Math.max(0, activeIndex())];
      if (row) row.click();
    }
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".model-option");
    if (!row) return;
    chooseModel(row.dataset.id, row.querySelector(".model-option-name")?.textContent || "");
  });
}

function modelOptionHtml(model, { current, recommended = false } = {}) {
  const selected = model.id === current;
  return `<button type="button" class="model-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-id="${escapeAttr(model.id)}" title="${escapeAttr(model.id)}">
    <span class="model-check" aria-hidden="true">${selected ? `<svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="m3.5 8.5 3 3 6-6.5"/></svg>` : ""}</span>
    <span class="model-option-name">${escapeHtml(model.name)}</span>
    ${recommended ? `<span class="model-chip">Recommended</span>` : ""}
    <span class="model-option-price">${escapeHtml(formatModelPrice(model))}</span>
  </button>`;
}

function customModelRowHtml(query) {
  return `<button type="button" class="model-option model-use-custom" role="option" data-id="${escapeAttr(query)}" title="${escapeAttr(query)}">
    <span class="model-check" aria-hidden="true"></span>
    <span class="model-option-name">Use “${escapeHtml(query)}”</span>
    <span class="model-option-price">as-is</span>
  </button>`;
}

function syncModelSelectLabel(panel) {
  const settings = loadSettings();
  const current = settings.answer_model || providerFor(settings.preset).answer_model;
  const nameEl = panel.querySelector("#model-select-name");
  if (nameEl) nameEl.textContent = modelDisplayName(current);
  const select = panel.querySelector("#model-select");
  if (select) select.title = current;
}

function applySettingsPatch(patch) {
  const current = loadSettings();
  const merged = { ...current, ...patch };
  const providerChanged = providerFor(merged.preset).id !== providerFor(current.preset).id;
  const apiKey = Object.prototype.hasOwnProperty.call(patch, "api_key")
    ? patch.api_key
    : getApiKey(providerChanged ? merged : current);
  saveSettings({ ...merged, api_key: apiKey });
  refreshCurrentBrain();
}

async function commitSettingsKey(panel, { required = false } = {}) {
  const input = panel.querySelector("#api-key");
  const status = panel.querySelector("#api-key-status");
  if (!input || !status) return false;
  const value = input.value.trim();
  const settings = loadSettings();
  const preset = providerFor(settings.preset);
  const token = ++settingsKeyToken;

  if (!value) {
    if (getApiKey(settings)) {
      applySettingsPatch({ api_key: "" });
      setKeyStatus(status, "Key removed.", "hint");
    } else {
      setKeyStatus(status, keyIdleWhisper(preset), "idle");
    }
    return false;
  }
  if (await maybeSwitchProviderFromKey(value, panel, async () => {
    const freshStatus = document.querySelector("#settings-panel #api-key-status");
    setKeyStatus(freshStatus, `Saved for ${providerFor(loadSettings().preset).label}.`, "valid");
  })) return false;
  const hint = providerKeyHint(value, preset.id);
  if (hint) {
    setKeyStatus(status, hint, "hint");
    if (required) shake(() => input.classList.add("shake-once"));
    if (preset.id === "openrouter" && !isPlausibleOpenRouterKey(value)) return false;
  }
  if (!preset.requires_key || preset.id !== "openrouter") {
    applySettingsPatch({ api_key: value });
    if (!hint) setKeyStatus(status, `Saved for ${preset.label}.`, "valid");
    return true;
  }
  if (!isPlausibleOpenRouterKey(value)) {
    setKeyStatus(status, value.startsWith("sk-or-") ? "That OpenRouter key looks incomplete." : "OpenRouter keys start with sk-or-v1-.", required ? "invalid" : "hint");
    if (required) shake(() => input.classList.add("shake-once"));
    return false;
  }
  setKeyStatus(status, "Checking with OpenRouter…", "busy");
  try {
    const result = await validateOpenRouterKey(value);
    if (token !== settingsKeyToken) return false;
    applySettingsPatch({ api_key: value });
    setKeyStatus(status, openRouterValidMessage(result), "valid");
    return true;
  } catch (err) {
    if (token !== settingsKeyToken) return false;
    if (err?.status === 401 || err?.status === 403) {
      setKeyStatus(status, err.message, "invalid");
      shake(() => input.classList.add("shake-once"));
      return false;
    }
    // OpenRouter unreachable — don't hold the user's key hostage over our check.
    applySettingsPatch({ api_key: value });
    setKeyStatus(status, "Saved — couldn't verify right now.", "hint");
    return true;
  }
}

function keyIdleWhisper(preset) {
  return `Stored only in this browser, sent directly to ${preset.label}.`;
}

function eyeSvg(open) {
  return open
    ? `<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/><path d="m3.2 2.6 9.6 10.8"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>`;
}

function toggleKeyReveal(input, button) {
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.innerHTML = eyeSvg(!showing);
  button.setAttribute("aria-label", showing ? "Show key" : "Hide key");
  button.setAttribute("aria-pressed", showing ? "false" : "true");
}

function refreshCurrentBrain(settings = loadSettings()) {
  if (!currentHost) return;
  const key = getApiKey(settings);
  currentHost.brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
}

function handleBranchAuthRequired({ node, error, retry }) {
  pendingBranchRetry = retry;
  const missingKey = error?.code === "missing_key";
  const slot = document.getElementById("settings-inline-key");
  slot.hidden = false;
  renderInlineKeyPanel(slot, {
    idPrefix: "branch",
    title: missingKey ? "Add a key to ask" : "Update your key",
    note: missingKey ? "" : "Your ask is saved and will continue once a key is connected.",
    status: missingKey ? "" : (error?.message || ""),
    afterValidated: async () => {
      slot.hidden = true;
      pendingBranchRetry = null;
      refreshCurrentBrain();
      retry?.();
      showToast({ message: `Retrying "${node?.title || "ask"}".` });
    },
  });
  openSettingsModal({ focusSelector: "#branch-key" });
}

function renderInlineKeyPanel(container, { idPrefix, title = "", note = "", status = "", afterValidated = null } = {}) {
  const settings = loadSettings();
  const preset = providerFor(settings.preset);
  const remember = settings.session_only === false;
  const heading = title || "Add a key to ask";
  const body = note || (preset.id === "openrouter"
    ? "Use your own OpenRouter key for every model. Stored only in this browser and sent directly to OpenRouter."
    : `Use your own ${preset.label} key. Stored only in this browser and sent directly to ${preset.label}.`);
  container.innerHTML = `<section class="inline-key-panel">
    <div class="inline-key-copy">
      <h3>${escapeHtml(heading)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>
    <div class="key-input-wrap">
      <input id="${idPrefix}-key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(apiKeyPlaceholder(preset.id))}" value="">
      <button id="${idPrefix}-key-toggle" type="button" aria-label="Show key" aria-pressed="false">${eyeSvg(false)}</button>
    </div>
    <div id="${idPrefix}-key-status" class="key-status" aria-live="polite"></div>
    <div class="inline-key-foot">
      <label class="remember-mini" for="${idPrefix}-remember">
        <span class="switch" aria-hidden="true">
          <input id="${idPrefix}-remember" type="checkbox" role="switch" ${remember ? "checked" : ""}>
          <span class="switch-track"></span>
        </span>
        <span>Remember on this device</span>
      </label>
      ${preset.id === "openrouter" ? `<a class="key-get" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key →</a>` : ""}
    </div>
  </section>`;
  const input = container.querySelector(`#${idPrefix}-key`);
  const statusEl = container.querySelector(`#${idPrefix}-key-status`);
  const toggle = container.querySelector(`#${idPrefix}-key-toggle`);
  toggle.addEventListener("click", () => toggleKeyReveal(input, toggle));
  if (status) setKeyStatus(statusEl, status, "invalid");
  let timer = 0;
  let continued = false;
  const continueOnce = async () => {
    if (continued) return;
    continued = true;
    saveSettings({
      ...loadSettings(),
      api_key: input.value.trim(),
      session_only: !container.querySelector(`#${idPrefix}-remember`).checked,
    });
    initSettingsPanel();
    refreshCurrentBrain();
    await afterValidated?.();
  };
  const validate = async (required = false) => {
    const presetId = loadSettings().preset || "openrouter";
    const switched = await maybeSwitchProviderFromKey(input.value, container, continueOnce);
    if (switched) return true;
    const ok = await validateKeyForPreset({
      key: input.value,
      presetId,
      statusEl,
      required,
      onShake: () => input.classList.add("shake-once"),
    });
    if (ok && input.value.trim()) await continueOnce();
    return ok;
  };
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const hint = providerKeyHint(input.value, loadSettings().preset || "openrouter");
    setKeyStatus(statusEl, hint, hint ? "hint" : "");
    timer = window.setTimeout(() => validate(false), 350);
  });
  input.addEventListener("paste", () => window.setTimeout(() => validate(false), 0));
  input.addEventListener("blur", () => validate(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      validate(true);
    }
  });
  input.focus({ preventScroll: true });
}

async function maybeSwitchProviderFromKey(key, container, continueOnce) {
  return false;
}

async function validateKeyForPreset({ key, presetId, statusEl, required = false, onShake = null } = {}) {
  const value = String(key || "").trim();
  const preset = providerFor(presetId);
  if (!preset.requires_key) {
    setKeyStatus(statusEl, "No key required for this provider.", "valid");
    return true;
  }
  const hint = providerKeyHint(value, preset.id);
  if (!value) {
    if (required) {
      setKeyStatus(statusEl, "Enter a key first.", "invalid");
      shake(onShake);
      return false;
    }
    setKeyStatus(statusEl, "", "");
    return false;
  }
  if (hint) {
    setKeyStatus(statusEl, hint, "hint");
    if (required && /truncated|looks like/i.test(hint)) shake(onShake);
    if (preset.id !== "openrouter") return true;
    if (!isPlausibleOpenRouterKey(value)) return false;
  }
  if (preset.id !== "openrouter") {
    setKeyStatus(statusEl, "Key saved for this provider.", "valid");
    return true;
  }
  if (!isPlausibleOpenRouterKey(value)) {
    setKeyStatus(statusEl, "That OpenRouter key looks too short.", "invalid");
    if (required) shake(onShake);
    return false;
  }
  setKeyStatus(statusEl, "Validating...", "busy");
  try {
    const result = await validateOpenRouterKey(value);
    setKeyStatus(statusEl, openRouterValidMessage(result), "valid");
    return true;
  } catch (err) {
    setKeyStatus(statusEl, err?.message || "OpenRouter rejected that key.", "invalid");
    shake(onShake);
    return false;
  }
}

async function validateOpenRouterKey(key) {
  const response = await fetch(OPENROUTER_KEY_CHECK_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? "That key was rejected by OpenRouter."
      : `OpenRouter returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  let json = {};
  try { json = await response.json(); } catch {}
  return json;
}

function providerKeyHint(key, presetId) {
  const value = String(key || "").trim();
  if (!value) return "";
  if (presetId === "openrouter" && value.startsWith("sk-ant-")) return "That looks like an Anthropic key — use an OpenRouter key here.";
  if (presetId === "openrouter" && value.startsWith("sk-") && !value.startsWith("sk-or-") && !value.startsWith("sk-ant-")) {
    return "That looks like an OpenAI key — use an OpenRouter key here.";
  }
  if (presetId === "openrouter" && value.startsWith("sk-or-v1-") && value.length < 30) {
    return "That OpenRouter key looks truncated.";
  }
  return "";
}

function isPlausibleOpenRouterKey(value) {
  return /^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(String(value || "").trim());
}

function openRouterValidMessage(result) {
  const data = result?.data || result || {};
  const label = data.label || data.name || data.key_name || "";
  const limit = data.limit || data.usage_limit || data.limit_remaining || "";
  const detail = [label, limit ? `limit ${limit}` : ""].filter(Boolean).join(" · ");
  return detail ? `Connected · ${detail}` : "Connected";
}

function setKeyStatus(el, message, tone = "") {
  if (!el) return;
  el.textContent = message || "";
  el.className = `key-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
}

function shake(onShake) {
  onShake?.();
  window.setTimeout(() => document.querySelectorAll(".shake-once").forEach((el) => el.classList.remove("shake-once")), 260);
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

function setBlankZoom(value) {
  blankZoom = Math.min(2.5, Math.max(0.15, Number(value) || 1));
  const world = document.getElementById("world");
  if (world && !currentHoleId) world.style.transform = `translate(0px,0px) scale(${blankZoom})`;
  const label = document.getElementById("zoom-label");
  if (label && !currentHoleId) label.textContent = `${Math.round(blankZoom * 100)}%`;
}

function toggleBlankTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("rh-theme", next); } catch {}
}

function isPdfFile(file) {
  return /(\.pdf$|application\/pdf)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isRabbitholeFile(file) {
  return /\.rabbithole$/i.test(file?.name || "");
}

function isMarkdownFile(file) {
  return /(\.md$|\.markdown$|markdown|text\/plain|application\/json)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isSingleHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text || /\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function holeIdFromHash() {
  const match = /^#hole=(.+)$/.exec(location.hash || "");
  return match ? decodeURIComponent(match[1]) : "";
}

function formatRelativeDate(value, { compact = false } = {}) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return compact ? "unknown" : "Updated at an unknown time";
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
    const formatted = formatter.format(Math.round(deltaSeconds / divisor), unit);
    return compact ? formatted : `Updated ${formatted}`;
  } catch {
    return date.toLocaleString(undefined, { month: "short", day: "numeric" });
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

function apiKeyPlaceholder(presetId) {
  switch (providerFor(presetId).id) {
    case "openrouter": return "sk-or-v1-...";
    default: return "optional";
  }
}

function isAuthLikeError(err) {
  return err?.status === 401 ||
    err?.status === 403 ||
    err?.code === "missing_key" ||
    /api key|401|403|unauthorized|forbidden/i.test(err?.message || String(err));
}

function autoGrowTextarea(textarea, maxHeight) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(maxHeight, textarea.scrollHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function isEditableTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable='true']");
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

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
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

function exposeTestApi() {
  window.__rhWebApp = {
    store,
    exportSnapshotForTest: async () => buildSnapshotHtml(await buildSnapshotHydration()),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => id ? store.readRawHoleForTest(id) : null,
    createDocumentForTest: createFromComposerDocument,
    deleteHoleForTest: deleteHoleFromRail,
    exportHoleFromRailForTest: exportHoleFromRail,
  };
}
