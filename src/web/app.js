import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, providerFor } from "./brain/index.js";
import { ensureCanonical, loadSettings, saveSettings } from "./settings/preferences-store.js";
import { getApiKey } from "./settings/credential-store.js";
import { createSettingsPopover, apiKeyPlaceholder } from "./settings/settings-popover.js";
import { installTestSeam } from "./test-seam.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, createPendingHoleFromQuestion } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { openDialog } from "../ui/primitives/dialog.js";
import { fieldMarkup, wireField } from "../ui/primitives/field.js";
import { buttonMarkup } from "../ui/primitives/button.js";
import { wireNotice } from "../ui/primitives/notice.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml } from "../ui/snapshot.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { downloadRabbitholeExport, importRabbitholeFile, rabbitholeFilename } from "./portable.js";

const LAST_HOLE_KEY = "rh-last-hole";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const OPENROUTER_KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";

const store = new IdbStore();
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;
let railOpen = false;
let blankZoom = 1;
let composerDialog = null;
let settingsController = null;
let composerPath = "";
let pendingComposerAction = null;
let pendingBranchRetry = null;
let lastHoleCount = 0;
let toastNotice = null;

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
  initGlobalDrops();

  const initial = await chooseInitialHole();
  await renderRail();
  if (initial) {
    await startHole(initial, { replace: true });
  } else {
    showBlankCanvas({ openComposer: true });
  }
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
    <div id="composer-modal" class="composer-modal" hidden>
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
      ${buttonMarkup({ bare: true, id: "blank-start-new", className: "blank-start-new", label: "New Rabbithole", kbdHint: "N", svgIconHtml: '<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/></svg>' })}
      <p class="blank-start-sub">or drop a PDF or Markdown file anywhere</p>
    </div>
    <div id="web-toast" class="web-toast"><span data-notice-message></span>${buttonMarkup({ bare: true, label: "Action", hidden: true, dataAttrs: { noticeAction: "" } })}</div>`;
  toastNotice = wireNotice(document.getElementById("web-toast"), { variant: "toast" });
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
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", (event) => openComposer({ source: "button", trigger: event.currentTarget }));
  const settingsTrigger = document.getElementById("t-settings");
  settingsController = createSettingsPopover({
    trigger: settingsTrigger,
    onSettingsChange: refreshCurrentBrain,
    onClose: () => { pendingBranchRetry = null; },
    eyeSvg,
    setKeyStatus,
    validateKey: validateKeyForPreset,
  });
  settingsTrigger?.addEventListener("click", () => settingsController.open());
  document.getElementById("blank-start-new")?.addEventListener("click", (event) => openComposer({ source: "button", trigger: event.currentTarget }));
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
      const trigger = document.getElementById("blank-start-new")?.offsetParent !== null
        ? document.getElementById("blank-start-new")
        : document.getElementById("t-new");
      openComposer({ source: "keyboard", trigger });
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

function openComposer({ source = "button", value = "", trigger } = {}) {
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
  document.getElementById("blank-start").hidden = true;
  if (value) selectComposerPath(isSingleHttpUrl(value) ? "url" : "ask", { value });
  composerDialog?.close("programmatic", { restoreFocus: false });
  composerDialog = openDialog({
    backdrop: modal,
    dialog: card,
    labelledby: "composer-title",
    trigger,
    initialFocus: value ? input : card,
    onClose: finishClosingComposer,
  });
}

function closeComposer() {
  composerDialog?.close("programmatic");
}

function finishClosingComposer() {
  const modal = document.getElementById("composer-modal");
  modal.hidden = true;
  modal.classList.remove("dragging");
  pendingComposerAction = null;
  clearComposerKeyPanel();
  composerDialog = null;
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
  currentHost.startRootAnswer();
}

function closeComposerSilently() {
  const modal = document.getElementById("composer-modal");
  if (modal) modal.hidden = true;
  composerDialog?.close("programmatic", { restoreFocus: false });
  composerDialog = null;
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

function eyeSvg(open) {
  return open
    ? `<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/><path d="m3.2 2.6 9.6 10.8"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>`;
}

function refreshCurrentBrain(settings = loadSettings()) {
  if (!currentHost) return;
  const key = getApiKey(settings);
  currentHost.brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
}

function handleBranchAuthRequired({ node, error, retry }) {
  pendingBranchRetry = retry;
  const missingKey = error?.code === "missing_key";
  settingsController.open();
  const slot = settingsController.getInlineKeySlot();
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
  settingsController.open({ focusSelector: "#branch-key" });
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
  const { input } = wireField(container, { id: `${idPrefix}-key`, toggleId: `${idPrefix}-key-toggle`, renderToggle: eyeSvg });
  const statusEl = container.querySelector(`#${idPrefix}-key-status`);
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
    settingsController.refresh();
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

async function buildLiveAssetData(holeId) {
  const out = {};
  for (const name of await store.listAssets(holeId)) {
    const blob = await store.getAsset(holeId, name);
    if (blob) out[name] = URL.createObjectURL(blob);
  }
  return out;
}

function showToast({ message, actionLabel = "", timeoutMs = 4000, onAction = null } = {}) {
  toastNotice?.show({ message, actionLabel, onAction, duration: timeoutMs });
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
