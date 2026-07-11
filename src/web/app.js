import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, providerFor } from "./brain/index.js";
import { ensureCanonical, loadSettings } from "./settings/preferences-store.js";
import { getApiKey } from "./settings/credential-store.js";
import { createSettingsPopover } from "./settings/settings-popover.js";
import { getGenerationSetupStatus, invalidateGenerationSetup } from "./settings/setup-readiness.js";
import { installTestSeam } from "./test-seam.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, createPendingHoleFromQuestion } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { openDialog } from "../ui/primitives/dialog.js";
import { buttonMarkup } from "../core/html/button-markup.js";
import { wireNotice } from "../ui/primitives/notice.js";
import { setSnapshotHooks, buildSnapshotProjection, buildSnapshotHtml } from "../ui/snapshot.js";
import { flushPendingSaves } from "../ui/transport-status.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { buildRabbitholeExport, downloadRabbitholeExport, importRabbitholeFile, importSnapshotFile, rabbitholeFilename } from "./portable.js";

const LAST_HOLE_KEY = "rh-last-hole";
const OPENROUTER_KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";

const store = new IdbStore();
let currentHost = null;
let currentHoleId = null;
let currentUi = null;
let currentAssetLease = null;
let holeTransition = Promise.resolve();
let railOpen = false;
let blankZoom = 1;
let composerDialog = null;
let settingsController = null;
let composerPath = "";
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
    showBlankCanvas();
  }
  installTestSeam({
    store,
    currentHoleId: () => currentHoleId,
    createDocument: createFromComposerDocument,
    exportSnapshot: async () => buildSnapshotHtml(await buildSnapshotProjection()),
    exportPortable: async () => {
      await flushPendingSaves();
      await currentHost?.flushSave();
      return buildRabbitholeExport(store, currentHoleId);
    },
  });
}

function renderShell() {
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
        <input id="file-md" type="file" accept=".md,.markdown,.pdf,.rabbithole,.html,text/markdown,text/plain,text/html,application/pdf,application/json" hidden>
        <div id="ingest-status" class="ingest-status" aria-live="polite" aria-atomic="true"></div>
      </div>
    </div>
    <div id="blank-start" class="blank-start" hidden>
      ${buttonMarkup({ bare: true, id: "blank-start-new", className: "blank-start-new", label: "New Rabbithole", kbdHint: "N", svgIconHtml: '<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/></svg>' })}
      ${buttonMarkup({ bare: true, id: "blank-start-setup", className: "blank-start-setup", label: "Set up AI" })}
      <p id="blank-start-status" class="blank-start-sub">Set up AI before starting a Rabbithole.</p>
    </div>
    <div id="web-toast" class="web-toast"><span data-notice-message></span>${buttonMarkup({ bare: true, label: "Action", hidden: true, dataAttrs: { noticeAction: "" } })}</div>`;
  toastNotice = wireNotice(document.getElementById("web-toast"), { variant: "toast" });
  document.getElementById("toolbar")?.insertAdjacentHTML("afterbegin",
    `<span class="toolbar-brand" title="Rabbithole" aria-label="Rabbithole">${bunnyMarkSvg()}</span><span class="sep toolbar-brand-sep"></span>`);
  railOpen = false;
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void currentHost?.flushSave();
  });
  window.addEventListener("pagehide", () => { void currentHost?.flushSave(); });
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", (event) => requestNewRabbithole({ source: "button", trigger: event.currentTarget }));
  const settingsTrigger = document.getElementById("t-settings");
  settingsController = createSettingsPopover({
    trigger: settingsTrigger,
    onSettingsChange: () => { refreshCurrentBrain(); syncGenerationSetupUi(); },
    eyeSvg,
    setKeyStatus,
    validateKey: validateKeyForPreset,
  });
  settingsTrigger?.addEventListener("click", () => settingsController.open());
  document.getElementById("blank-start-new")?.addEventListener("click", (event) => requestNewRabbithole({ source: "button", trigger: event.currentTarget }));
  document.getElementById("blank-start-setup")?.addEventListener("click", (event) => openModelSetup({ trigger: event.currentTarget }));
  syncGenerationSetupUi();
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
  rail?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Contain Escape to the rail: the canvas client's document-level handler
    // treats a loose Escape as "open the reader".
    event.stopPropagation();
    setRailOpen(false);
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
      requestNewRabbithole({ source: "keyboard", trigger });
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
      if (getGenerationSetupStatus().ready) document.body.classList.add("blank-dragging");
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
    if (!getGenerationSetupStatus().ready) {
      openModelSetup({ trigger: document.getElementById("blank-start-setup") });
      return;
    }
    openComposer({ source: "drop" });
    await createFromFile(file);
  });
}

function requestNewRabbithole({ source = "button", value = "", trigger } = {}) {
  if (!getGenerationSetupStatus().ready) {
    openModelSetup({ trigger });
    return;
  }
  openComposer({ source, value, trigger });
}

function openModelSetup({ trigger, status = "", onReady = null } = {}) {
  const blankSetup = document.getElementById("blank-start-setup");
  const safeTrigger = trigger?.disabled ? (blankSetup?.offsetParent !== null ? blankSetup : document.getElementById("t-settings")) : trigger;
  settingsController.open({ trigger: safeTrigger || document.getElementById("t-settings"), purpose: status ? "recovery" : "setup", status, onReady });
}

function syncGenerationSetupUi() {
  const setup = getGenerationSetupStatus();
  const newButtons = [document.getElementById("blank-start-new"), document.getElementById("t-new")].filter(Boolean);
  newButtons.forEach((button) => { button.disabled = !setup.ready; });
  const blankNew = document.getElementById("blank-start-new");
  const setupButton = document.getElementById("blank-start-setup");
  const status = document.getElementById("blank-start-status");
  if (blankNew) {
    if (setup.ready) blankNew.removeAttribute("aria-describedby");
    else blankNew.setAttribute("aria-describedby", "blank-start-status");
  }
  if (setupButton) setupButton.textContent = setup.ready ? "Model settings" : "Set up AI";
  if (status) status.hidden = setup.ready;
}

function openComposer({ source = "button", value = "", trigger } = {}) {
  if (!getGenerationSetupStatus().ready) {
    openModelSetup({ trigger });
    return;
  }
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const card = document.getElementById("composer-card");

  composerPath = "";
  setIngestStatus("");
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

function finishClosingComposer() {
  const modal = document.getElementById("composer-modal");
  modal.hidden = true;
  modal.classList.remove("dragging");
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
  try {
    const hole = await maybeAuthorDocument({
      title: "",
      markdown,
      sourceName: "pasted text",
      kind: "paste",
      improveStructure,
    });
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

  try {
    const hole = createPendingHoleFromQuestion(question);
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    const message = err?.message || String(err);
    if (isAuthLikeError(err)) {
      invalidateGenerationSetup();
      syncGenerationSetupUi();
      settingsController.open({ trigger: document.getElementById("t-settings"), purpose: "recovery", status: message, onReady: action, focusKey: true });
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
  if (isSnapshotFile(file)) return createFromSnapshotFile(file);
  if (isPdfFile(file)) return createFromPdfFile(file);
  if (!isMarkdownFile(file)) {
    setIngestStatus("Choose a markdown, PDF, .rabbithole, or snapshot HTML file.", "error");
    return;
  }
  if (file.size > 16 * 1024 * 1024) {
    setIngestStatus("Import failed: file exceeds 16 MB.", "error");
    return;
  }
  try {
    setIngestStatus("Reading markdown file...", "busy");
    const markdown = await file.text();
    const hole = await maybeAuthorDocument({
      title: file.name.replace(/\.[^.]+$/, ""),
      markdown,
      sourceName: file.name,
      kind: "file",
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Markdown import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromSnapshotFile(file) {
  try {
    setIngestStatus("Importing Rabbithole snapshot...", "busy");
    const imported = await importSnapshotFile(store, file);
    setIngestStatus("");
    const hole = await store.loadHole(imported.hole_id);
    if (!hole) throw new Error("Imported snapshot could not be loaded.");
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

async function maybeAuthorDocument({
  title = "",
  markdown = "",
  sourceName = "",
  kind = "source",
  baseUrl = "",
  improveStructure = false,
} = {}) {
  const hole = createHoleFromMarkdown({ title, markdown, baseUrl });
  if (!improveStructure) {
    await store.saveHole(hole);
    return hole;
  }
  const settings = loadSettings();
  const key = getApiKey(settings);
  setIngestStatus("Improving structure with the author model...", "busy");
  const brain = createBrain(settings, key);
  const root = hole.nodes[0];
  root.status = "pending";
  root.markdown = "";
  const host = new DirectRabbitholeHost({ store, hole, brain });
  return host.authorDocument({
    title,
    markdown,
    source_name: sourceName,
    kind,
    base_url: baseUrl,
  }, { onProgress: (length) => {
    if (length) setIngestStatus(`Improving structure... ${length.toLocaleString()} characters`, "busy");
  } });
}

function startHole(hole, options = {}) {
  const transition = holeTransition.then(() => mountHole(hole, options));
  holeTransition = transition.catch(() => {});
  return transition;
}

async function mountHole(hole, { replace = false } = {}) {
  await disposeCurrentHole();
  resetHoleSurface();
  currentHoleId = hole.hole_id;
  document.body.classList.remove("web-blank-canvas");
  document.getElementById("blank-start").hidden = true;
  closeComposerSilently();
  safeLocalStorageSet(LAST_HOLE_KEY, hole.hole_id);
  if (replace) history.replaceState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);
  else history.pushState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);

  setSnapshotHooks({
    fetchAssetBinary: async (name) => store.getAsset(currentHoleId, name),
    getSnapshotHole: async () => {
      await currentHost.flushSave();
      return store.loadHole(currentHoleId);
    },
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
    getStylesheetText: () => window.__RABBITHOLE_FROZEN_STYLES__ || "",
  });

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  const host = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    onToast: (notice) => { if (currentHost === host) showToast(notice); },
    onDone: async () => {
      if (currentHost !== host) return;
      await host.flushSave();
      history.replaceState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => { if (currentHost === host) location.reload(); },
    onAuthRequired: (...args) => { if (currentHost === host) return handleBranchAuthRequired(...args); },
    onRootAnswered: () => { if (currentHost === host) return renderRail(); },
  });
  currentHost = host;

  try {
    const hydration = host.hydration();
    currentAssetLease = await createLiveAssetData(hole.hole_id);
    hydration.asset_data = currentAssetLease.data;
    currentUi = startRabbithole(hydration, {
      transport: host.adapter(),
      exportPortable: exportCurrentRabbithole,
    });
    document.getElementById("r-canvas")?.click();
    await renderRail();
    host.startRootAnswer();
  } catch (error) {
    await disposeCurrentHole();
    throw error;
  }
}

async function disposeCurrentHole() {
  settingsController?.close();
  closeComposerSilently();
  const ui = currentUi;
  const host = currentHost;
  const assets = currentAssetLease;
  currentUi = null;
  currentHost = null;
  currentAssetLease = null;
  currentHoleId = null;
  const errors = [];
  if (ui) {
    try { await ui.flush(); } catch (error) { errors.push(error); }
    try { await ui.dispose(); } catch (error) { errors.push(error); }
  }
  if (host) {
    try { await host.flushSave(); } catch (error) { errors.push(error); }
    try { await host.dispose(); } catch (error) { errors.push(error); }
  }
  try { assets?.dispose(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Failed to dispose the previous Rabbithole");
}

function resetHoleSurface() {
  document.body.classList.remove("agent-down", "session-over", "blank-dragging", "frozen");
  const world = document.getElementById("world");
  if (world) {
    const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    edges.id = "edges";
    world.replaceChildren(edges);
    world.style.transform = "";
  }
  document.getElementById("reader-main")?.replaceChildren();
  document.getElementById("reader-side")?.replaceChildren();
  document.getElementById("breadcrumb")?.replaceChildren();
}

function closeComposerSilently() {
  const modal = document.getElementById("composer-modal");
  if (modal) modal.hidden = true;
  composerDialog?.close("programmatic", { restoreFocus: false });
  composerDialog = null;
}

function showBlankCanvas() {
  currentHost = null;
  currentHoleId = null;
  document.body.classList.add("mode-canvas", "web-blank-canvas");
  const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edges.id = "edges";
  document.getElementById("world").replaceChildren(edges);
  setBlankZoom(1);
  history.replaceState(null, "", location.pathname);
  document.getElementById("blank-start").hidden = false;
  syncGenerationSetupUi();
}

async function exportCurrentRabbithole() {
  await flushPendingSaves();
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
  let inner = rail.querySelector(":scope > .rail-inner");
  let list = inner?.querySelector(":scope > .rail-list");
  if (!inner || !list) {
    inner = document.createElement("div"); inner.className = "rail-inner";
    list = document.createElement("div"); list.className = "rail-list"; list.id = "rail-list";
    inner.appendChild(list); rail.replaceChildren(inner);
  }
  const rows = new Map(Array.from(list.querySelectorAll(".rail-row"), (row) => [row.dataset.hole, row]));
  const next = summaries.map((summary) => {
    const row = rows.get(summary.hole_id) || createRailRow(summary.hole_id);
    patchRailRow(row, summary);
    return row;
  });
  if (!next.length) {
    const empty = list.querySelector(".rail-empty") || document.createElement("div");
    empty.className = "rail-empty"; empty.textContent = "No Rabbitholes yet."; next.push(empty);
  }
  list.replaceChildren(...next);
  applyRailState();
}

function createRailIconButton(className, label, paths) {
  const button = document.createElement("button");
  button.className = `rail-icon ${className}`; button.type = "button"; button.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ width: "15", height: "15", viewBox: "0 0 16 16", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of paths) { const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", d); svg.appendChild(path); }
  button.appendChild(svg);
  return button;
}

function createRailRow(holeId) {
  const row = document.createElement("article"); row.className = "rail-row"; row.dataset.hole = holeId;
  const open = document.createElement("button"); open.className = "rail-open"; open.type = "button";
  const copy = document.createElement("span"); copy.className = "rail-row-copy";
  const title = document.createElement("span"); title.className = "rail-title"; copy.appendChild(title); open.appendChild(copy);
  const actions = document.createElement("span"); actions.className = "rail-actions";
  actions.append(
    createRailIconButton("rail-export", "Export", ["M8 2.75v7", "M5.25 7.1 8 9.85l2.75-2.75", "M3.25 12.75h9.5"]),
    createRailIconButton("rail-delete", "Delete", ["M3.25 4.25h9.5", "M6.25 2.75h3.5", "M5.25 4.25v8.25h5.5V4.25", "M7 6.5v3.75", "M9 6.5v3.75"])
  );
  row.append(open, actions);
  return row;
}

function patchRailRow(row, summary) {
  const title = summary.title || "Untitled";
  const updated = formatRelativeDate(summary.updated_at);
  row.classList.toggle("current", summary.hole_id === currentHoleId);
  row.querySelector(".rail-title").textContent = title;
  const open = row.querySelector(".rail-open"); open.setAttribute("aria-label", title); open.title = updated;
  row.querySelector(".rail-export").setAttribute("aria-label", `Export ${title}`);
  row.querySelector(".rail-delete").setAttribute("aria-label", `Delete ${title}`);
}

async function deleteHoleFromRail(holeId) {
  if (!holeId) return;
  const deletingCurrent = holeId === currentHoleId;
  if (deletingCurrent) {
    await disposeCurrentHole();
    resetHoleSurface();
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
      showBlankCanvas();
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
  invalidateGenerationSetup();
  syncGenerationSetupUi();
  settingsController.open({
    trigger: document.getElementById("t-settings"),
    purpose: "recovery",
    status: error?.message || "Reconnect your model to continue.",
    focusKey: providerFor(loadSettings().preset).requires_key,
    onReady: async () => {
      refreshCurrentBrain();
      retry?.();
      showToast({ message: `Retrying "${node?.title || "ask"}".` });
    },
  });
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

async function createLiveAssetData(holeId) {
  const data = {};
  const urls = [];
  try {
    for (const name of await store.listAssets(holeId)) {
      const blob = await store.getAsset(holeId, name);
      if (blob) {
        const url = URL.createObjectURL(blob);
        data[name] = url;
        urls.push(url);
      }
    }
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
  let disposed = false;
  return {
    data,
    dispose() {
      if (disposed) return;
      disposed = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    },
  };
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
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return /\.pdf$/.test(name) || type === "application/pdf";
}

function isRabbitholeFile(file) {
  return /\.rabbithole$/i.test(file?.name || "");
}

function isSnapshotFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return /\.html?$/.test(name) || type === "text/html";
}

function isMarkdownFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return /\.(md|markdown)$/.test(name) ||
    type === "text/markdown" || type === "text/plain" || type === "application/json";
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
    const formatted = formatter.format(Math.round(deltaSeconds / divisor), unit);
    return `Updated ${formatted}`;
  } catch {
    return date.toLocaleString(undefined, { month: "short", day: "numeric" });
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

function applyInitialWebTheme() {
  try {
    let savedTheme = localStorage.getItem("rh-theme");
    if (savedTheme !== "dark" && savedTheme !== "light") savedTheme = "";
    if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch {}
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
