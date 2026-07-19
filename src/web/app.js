import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, providerFor } from "./brain/index.js";
import { detectPdfTranscriptionCapability, pdfTranscriptionCapability } from "./brain/pdf-transcription.js";
import { loadSettings, saveSettings } from "./settings/preferences-store.js";
import { getApiKey } from "./settings/credential-store.js";
import { createSettingsPopover } from "./settings/settings-popover.js";
import { createOllamaRecoveryDialog } from "./settings/ollama-recovery.js";
import { setKeyStatus, validateKeyForPreset } from "./settings/key-validation.js";
import { getGenerationSetupStatus, invalidateGenerationSetup } from "./settings/setup-readiness.js";
import { installTestSeam } from "./test-seam.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, createPendingHoleFromQuestion } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { syncPdfTranscriptionControls } from "../ui/pdf-view.js";
import { openDialog } from "../ui/primitives/dialog.js";
import { openPopover } from "../ui/primitives/popover.js";
import { buttonMarkup, iconButtonMarkup } from "../core/html/button-markup.js";
import { BUNNY_MARK_SVG, iconSvg } from "../core/html/icons.js";
import { escapeHtml } from "../core/utils.js";
import { wireNotice } from "../ui/primitives/notice.js";
import { setSnapshotHooks, buildSnapshotProjection, buildSnapshotHtml } from "../ui/snapshot.js";
import { flushPendingSaves } from "../ui/transport-status.js";
import { registerRendererAssetName } from "../ui/renderer.js";
import { isSubmitEnter } from "../ui/input-intent.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { describePdfImportFailure, ingestPdfToStoredHole } from "./ingest/pdf.js";
import { buildRabbitholeExport, downloadRabbitholeExport, importRabbitholeFile, importSnapshotFile, rabbitholeFilename } from "./portable.js";
import { createWhimsicalHoleId, holeIdFromPathname, pathnameForHole } from "./hole-id.js";
import { getMermaidSource, loadMermaidRuntime } from "./mermaid-runtime.js";

const LAST_HOLE_KEY = "rh-last-hole";
const GITHUB_REPO_API_URL = "https://api.github.com/repos/shlokkhemani/rabbithole";
const GITHUB_STARS_CACHE_KEY = "rh-github-stars-v1";
const GITHUB_STARS_CACHE_TTL = 6 * 60 * 60 * 1000;
const TOOLBAR_BUNNY_MARK_SVG = iconSvg("bunny", { size: 16 });

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
let ollamaRecoveryController = null;
let projectMenuPopover = null;
let githubStarsPromise = null;
let composerPath = "";
let lastHoleCount = 0;
let railSummaries = null;
let toastNotice = null;
let currentPdfTranscriptionCapability = pdfTranscriptionCapability(loadSettings());
let pdfTranscriptionCheckToken = 0;

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
  await renderRail({ refresh: railSummaries == null });
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
            <span class="composer-title-mark" aria-hidden="true">${BUNNY_MARK_SVG}</span>
            <h1 id="composer-title">Enter a Rabbithole</h1>
          </header>
          <div class="composer-paths" role="group" aria-label="Choose how to begin">
            <button class="composer-path" id="composer-path-ask" type="button" data-path="ask">
              <span class="composer-path-icon" aria-hidden="true">${iconSvg("question")}</span>
              <span class="composer-path-copy"><strong>Ask a question</strong><small>Begin with something you want to understand.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
            <button class="composer-path" id="composer-path-file" type="button" data-path="file">
              <span class="composer-path-icon" aria-hidden="true">${iconSvg("file")}</span>
              <span class="composer-path-copy"><strong>Open a document</strong><small>Bring in a PDF or Markdown file from your device.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
            <button class="composer-path" id="composer-path-paste" type="button" data-path="paste">
              <span class="composer-path-icon" aria-hidden="true">${iconSvg("paste")}</span>
              <span class="composer-path-copy"><strong>Paste text or Markdown</strong><small>Start from your clipboard.</small></span>
              <span class="composer-path-arrow" aria-hidden="true">→</span>
            </button>
            <button class="composer-path" id="composer-path-url" type="button" data-path="url">
              <span class="composer-path-icon" aria-hidden="true">${iconSvg("link")}</span>
              <span class="composer-path-copy"><strong>Open a link</strong><small>Start from an article, paper, or webpage.</small></span>
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
      <span id="blank-start-new-wrap" class="blank-start-new-wrap">
        ${buttonMarkup({ bare: true, id: "blank-start-new", className: "blank-start-new", label: "New Rabbithole", kbdHint: "N", svgIconHtml: iconSvg("plus") })}
        <span id="blank-start-status" class="blank-start-tooltip" role="tooltip">Set up AI before starting a Rabbithole.</span>
      </span>
      ${buttonMarkup({ bare: true, id: "blank-start-setup", className: "blank-start-setup", label: "Set up AI" })}
    </div>
    <nav id="project-menu" class="project-menu popover-surface" role="menu" aria-label="Rabbithole project" hidden>
      <div class="project-menu-head" role="presentation">
        <span class="project-menu-mark" aria-hidden="true">${BUNNY_MARK_SVG}</span>
        <span><strong>Rabbithole</strong><small>Open source · MIT</small></span>
      </div>
      <a class="project-menu-item" role="menuitem" href="/about/" target="_blank" rel="noopener noreferrer"><span>About Rabbithole</span><span aria-hidden="true">↗</span></a>
      <a class="project-menu-item" role="menuitem" href="/about/#install" target="_blank" rel="noopener noreferrer"><span>Install &amp; self-host</span><span aria-hidden="true">↗</span></a>
      <a class="project-menu-item project-menu-github" role="menuitem" href="https://github.com/shlokkhemani/rabbithole" target="_blank" rel="noopener noreferrer"><span>GitHub</span><span class="project-menu-meta"><span id="project-github-stars" class="github-star-count" aria-label="GitHub stars"><span aria-hidden="true">★</span> Stars</span><span aria-hidden="true">↗</span></span></a>
    </nav>
    <div id="web-toast" class="web-toast"><span data-notice-message></span>${buttonMarkup({ bare: true, label: "Action", hidden: true, dataAttrs: { noticeAction: "" } })}</div>`;
  toastNotice = wireNotice(document.getElementById("web-toast"), { variant: "toast" });
  document.getElementById("tb-tools")?.insertAdjacentHTML("afterbegin",
    `${iconButtonMarkup({ className: "toolbar-brand", id: "t-project", title: "About Rabbithole and project links", ariaLabel: "Rabbithole project menu", ariaHaspopup: "menu", ariaControls: "project-menu", ariaExpanded: "false", svgIconHtml: TOOLBAR_BUNNY_MARK_SVG })}<span class="sep toolbar-brand-sep"></span>`);
  railOpen = false;
  applyRailState();
  syncRailPosition();
  requestAnimationFrame(syncRailPosition);
}

async function chooseInitialHole() {
  const pathHole = holeIdFromPathname(location.pathname);
  if (pathHole) {
    return store.loadHole(pathHole);
  }
  const storedId = safeLocalStorageGet(LAST_HOLE_KEY);
  if (storedId) {
    const stored = await store.loadHole(storedId);
    if (stored) return stored;
  }
  const holes = await store.listHoles();
  railSummaries = holes;
  lastHoleCount = holes.length;
  if (!holes.length) return null;
  return store.loadHole(holes[0].hole_id);
}

function initAppChrome() {
  const rail = document.getElementById("web-rail");
  window.addEventListener("resize", syncRailPosition, { passive: true });
  window.addEventListener("popstate", () => { void openHistoryLocation(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void currentHost?.flushSave();
  });
  window.addEventListener("pagehide", () => {
    void currentHost?.flushSave();
    store.close();
  });
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", (event) => requestNewRabbithole({ source: "button", trigger: event.currentTarget }));
  const projectTrigger = document.getElementById("t-project");
  const projectMenu = document.getElementById("project-menu");
  projectTrigger?.addEventListener("click", () => projectMenuPopover ? closeProjectMenu() : openProjectMenu());
  projectMenu?.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeProjectMenu({ restoreFocus: false });
  });
  projectMenu?.addEventListener("keydown", moveProjectMenuFocus);
  const settingsTrigger = document.getElementById("t-settings");
  ollamaRecoveryController = createOllamaRecoveryDialog({
    onResolved: async ({ model, transcribeModel }) => {
      const current = loadSettings();
      saveSettings({ ...current, model, transcribe_model: transcribeModel, api_key: getApiKey(current) });
      settingsController?.completeLocalSetup?.();
      refreshCurrentBrain();
      syncGenerationSetupUi();
      if (currentHoleNeedsPdfTranscription()) void refreshPdfTranscriptionCapability();
    },
  });
  settingsController = createSettingsPopover({
    trigger: settingsTrigger,
    onSettingsChange: () => {
      refreshCurrentBrain();
      syncGenerationSetupUi();
      if (currentHoleNeedsPdfTranscription()) void refreshPdfTranscriptionCapability();
      else currentPdfTranscriptionCapability = pdfTranscriptionCapability(loadSettings());
    },
    eyeSvg,
    setKeyStatus,
    validateKey: validateKeyForPreset,
    openOllamaRecovery: ({ settings, trigger }) => ollamaRecoveryController.open({ settings, trigger }),
  });
  // The gear toggles: the layer stack ignores pointerdown on its own trigger,
  // so a second click reaches us with the popover still open — close it.
  settingsTrigger?.addEventListener("click", () => {
    if (settingsController.isOpen()) settingsController.close();
    else settingsController.open();
  });
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

function openProjectMenu() {
  const trigger = document.getElementById("t-project");
  const surface = document.getElementById("project-menu");
  if (!trigger || !surface || projectMenuPopover) return;
  surface.hidden = false;
  projectMenuPopover = openPopover({
    trigger,
    surface,
    placement: "top-start",
    initialFocus: surface.querySelector('[role="menuitem"]'),
    onClose: closeProjectMenu,
  });
  void loadGithubStars();
}

async function loadGithubStars() {
  const cached = readGithubStarsCache();
  if (cached) {
    renderGithubStars(cached.count);
    if (Date.now() - cached.updatedAt < GITHUB_STARS_CACHE_TTL) return;
  }
  if (githubStarsPromise) return githubStarsPromise;
  githubStarsPromise = fetch(GITHUB_REPO_API_URL, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const count = Number((await response.json())?.stargazers_count);
    if (!Number.isFinite(count) || count < 0) throw new Error("GitHub returned an invalid star count");
    const value = { count: Math.floor(count), updatedAt: Date.now() };
    safeLocalStorageSet(GITHUB_STARS_CACHE_KEY, JSON.stringify(value));
    renderGithubStars(value.count);
  }).catch(() => {}).finally(() => {
    githubStarsPromise = null;
  });
  return githubStarsPromise;
}

function readGithubStarsCache() {
  try {
    const value = JSON.parse(safeLocalStorageGet(GITHUB_STARS_CACHE_KEY));
    if (!Number.isFinite(value?.count) || !Number.isFinite(value?.updatedAt)) return null;
    return value;
  } catch {
    return null;
  }
}

function renderGithubStars(count) {
  const target = document.getElementById("project-github-stars");
  if (!target) return;
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(count);
  target.innerHTML = `<span aria-hidden="true">★</span> ${escapeHtml(compact)}`;
  target.setAttribute("aria-label", `${count.toLocaleString("en-US")} GitHub stars`);
  target.title = `${count.toLocaleString("en-US")} GitHub stars`;
}

function closeProjectMenu(settings) {
  if (!projectMenuPopover) return;
  const active = projectMenuPopover;
  projectMenuPopover = null;
  active.close(settings);
  document.getElementById("project-menu").hidden = true;
}

function moveProjectMenuFocus(event) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
  if (!items.length) return;
  event.preventDefault();
  const current = Math.max(0, items.indexOf(document.activeElement));
  const next = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
  items[next].focus({ preventScroll: true });
}

async function openHistoryLocation() {
  const holeId = holeIdFromPathname(location.pathname);
  if (holeId === currentHoleId) return;
  await currentHost?.flushSave();
  if (holeId) {
    const hole = await store.loadHole(holeId);
    if (hole) {
      await startHole(hole, { replace: true });
      return;
    }
  }
  await disposeCurrentHole();
  resetHoleSurface();
  showBlankCanvas();
}

function initComposer() {
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const primary = document.getElementById("composer-primary");
  const fileInput = document.getElementById("file-md");

  input.addEventListener("input", () => {
    autoGrowTextarea(input, composerInputMaxHeight());
  });
  input.addEventListener("keydown", (event) => {
    const submitPaste = composerPath === "paste" && isSubmitEnter(event) && (event.metaKey || event.ctrlKey);
    if (submitPaste || (composerPath !== "paste" && isSubmitEnter(event))) {
      event.preventDefault();
      runComposer();
    }
  });
  primary.addEventListener("click", runComposer);
  document.getElementById("composer-back").addEventListener("click", showComposerStart);
  document.getElementById("composer-path-ask").addEventListener("click", () => selectComposerPath("ask"));
  document.getElementById("composer-path-paste").addEventListener("click", () => selectComposerPath("paste"));
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
  const blankNewWrap = document.getElementById("blank-start-new-wrap");
  const setupButton = document.getElementById("blank-start-setup");
  const status = document.getElementById("blank-start-status");
  if (blankNew) {
    if (setup.ready) blankNew.removeAttribute("aria-describedby");
    else blankNew.setAttribute("aria-describedby", "blank-start-status");
  }
  if (blankNewWrap) blankNewWrap.toggleAttribute("data-disabled", !setup.ready);
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
  card.removeAttribute("data-path");
  document.getElementById("composer-start").hidden = false;
  document.getElementById("composer-entry").hidden = true;
  input.value = value;
  autoGrowTextarea(input, composerInputMaxHeight());
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
  const config = {
    ask: {
      title: "Ask a question",
      copy: "What would you like to understand?",
      placeholder: "Ask anything…",
      primary: "Start exploring",
    },
    paste: {
      title: "Paste text or Markdown",
      copy: "Paste anything you want to explore. We’ll keep the Markdown intact.",
      placeholder: "Paste text or Markdown here…",
      primary: "Open in Rabbithole",
    },
    url: {
      title: "Open a link",
      copy: "Paste a link to an article, paper, or webpage. arXiv works especially well.",
      placeholder: "https://…",
      primary: "Open in Rabbithole",
    },
  }[path];
  if (!config) return;
  composerPath = path;
  const input = document.getElementById("composer-input");
  document.getElementById("composer-start").hidden = true;
  document.getElementById("composer-entry").hidden = false;
  document.getElementById("composer-card").dataset.path = path;
  document.getElementById("composer-entry-title").textContent = config.title;
  document.getElementById("composer-entry-copy").textContent = config.copy;
  input.placeholder = config.placeholder;
  input.spellcheck = path !== "url";
  input.value = value;
  document.getElementById("composer-primary").textContent = config.primary;
  document.getElementById("composer-primary").title = path === "paste"
    ? "Create (Ctrl/⌘+Enter)"
    : "Submit (Enter) · New line (Shift+Enter)";
  autoGrowTextarea(input, composerInputMaxHeight());
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
  if (composerPath === "paste") return createFromComposerDocument(input.value);
}

async function createFromComposerDocument(markdown, { improveStructure = false } = {}) {
  if (!String(markdown || "").trim()) {
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
    setIngestStatus("Starting Rabbithole...", "busy");
    const hole = createPendingHoleFromQuestion(question);
    await store.saveHole(hole);
    setIngestStatus("Opening Rabbithole...", "busy");
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
    const imported = await importSnapshotFile(store, file, { mintHoleId: createWhimsicalHoleId });
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
    const imported = await importRabbitholeFile(store, file, { mintHoleId: createWhimsicalHoleId });
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
    setIngestStatus("Preparing PDF...", "busy");
    const { hole } = await ingestPdfToStoredHole({
      source: file,
      store,
      title: "",
      onProgress: ({ page, index, total }) => {
        if (page) setIngestStatus(`Preparing page ${index} of ${total}`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(describePdfImportFailure(err), "error");
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
  setIngestStatus("Improving structure with the model...", "busy");
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
  if (replace) history.replaceState(null, "", pathnameForHole(hole.hole_id));
  else history.pushState(null, "", pathnameForHole(hole.hole_id));

  setSnapshotHooks({
    fetchAssetBinary: async (name) => store.getAsset(currentHoleId, name),
    getSnapshotHole: async () => {
      await currentHost.flushSave();
      return store.loadHole(currentHoleId);
    },
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
    getPdfWorkerSource: () => window.__RABBITHOLE_FROZEN_PDF_WORKER_SOURCE__ || "",
    getPdfJsSource: () => window.__RABBITHOLE_FROZEN_PDFJS_SOURCE__ || "",
    getMermaidSource,
    getStylesheetText: () => window.__RABBITHOLE_FROZEN_STYLES__ || "",
  });

  if (hole.nodes?.some((node) => node?.extensions?.pdf?.version === 2 && !node.extensions.pdf.converted)) {
    await refreshPdfTranscriptionCapability();
  }
  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  const host = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    registerAssetUrl: (name, blob) => currentAssetLease?.register(name, blob),
    onToast: (notice) => { if (currentHost === host) showToast(notice); },
    onDone: async () => {
      if (currentHost !== host) return;
      await host.flushSave();
      history.replaceState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => { if (currentHost === host) location.reload(); },
    onAuthRequired: (...args) => { if (currentHost === host) return handleBranchAuthRequired(...args); },
    onProviderFailure: (...args) => { if (currentHost === host) return handleBranchProviderFailure(...args); },
    onRootAnswered: () => { if (currentHost === host) return renderRail(); },
    getPdfTranscriptionCapability: () => currentPdfTranscriptionCapability,
  });
  currentHost = host;

  try {
    const hydration = host.hydration();
    currentAssetLease = await createLiveAssetData(hole.hole_id);
    hydration.asset_data = currentAssetLease.data;
    currentUi = startRabbithole(hydration, {
      transport: host.adapter(),
      exportPortable: exportCurrentRabbithole,
      loadMermaid: loadMermaidRuntime,
      getPdfTranscriptionCapability: () => currentPdfTranscriptionCapability,
    });
    document.getElementById("t-canvas")?.click();
    const isNewRailItem = !railSummaries?.some((summary) => summary.hole_id === hole.hole_id);
    await renderRail({ refresh: isNewRailItem, firstHoleId: isNewRailItem ? hole.hole_id : null });
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

async function renderRail({ refresh = true, firstHoleId = null } = {}) {
  const rail = document.getElementById("web-rail");
  if (!rail) return;
  if (refresh || !railSummaries) railSummaries = await store.listHoles();
  const summaries = firstHoleId
    ? [...railSummaries].sort((a, b) => (b.hole_id === firstHoleId) - (a.hole_id === firstHoleId))
    : railSummaries;
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
  if (firstHoleId) list.scrollTop = 0;
  applyRailState();
}

function createRailIconButton(className, label, iconName) {
  const button = document.createElement("button");
  button.className = `rail-icon ${className}`; button.type = "button"; button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg(iconName);
  return button;
}

function createRailRow(holeId) {
  const row = document.createElement("article"); row.className = "rail-row"; row.dataset.hole = holeId;
  const open = document.createElement("button"); open.className = "rail-open"; open.type = "button";
  const copy = document.createElement("span"); copy.className = "rail-row-copy";
  const title = document.createElement("span"); title.className = "rail-title"; copy.appendChild(title); open.appendChild(copy);
  const actions = document.createElement("span"); actions.className = "rail-actions";
  actions.append(createRailIconButton("rail-delete", "Delete", "delete"));
  row.append(open, actions);
  return row;
}

function patchRailRow(row, summary) {
  const title = summary.title || "Untitled";
  const updated = formatRelativeDate(summary.updated_at);
  row.classList.toggle("current", summary.hole_id === currentHoleId);
  row.querySelector(".rail-title").textContent = title;
  const open = row.querySelector(".rail-open"); open.setAttribute("aria-label", title); open.title = updated;
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

function toggleRail() {
  setRailOpen(!railOpen);
}

function syncRailPosition() {
  const rail = document.getElementById("web-rail");
  const toolbar = document.getElementById("tb-tools");
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
  return iconSvg(open ? "eye-off" : "eye");
}

function refreshCurrentBrain(settings = loadSettings()) {
  if (!currentHost) return;
  const key = getApiKey(settings);
  currentHost.brain = key || !providerFor(settings.preset).requires_key ? createBrain(settings, key) : null;
}

function currentHoleNeedsPdfTranscription() {
  return !!currentHost && [...currentHost.state.nodes.values()].some((node) => node?.extensions?.pdf?.version === 2 && !node.extensions.pdf.converted);
}

async function refreshPdfTranscriptionCapability(settings = loadSettings()) {
  const token = ++pdfTranscriptionCheckToken;
  currentPdfTranscriptionCapability = pdfTranscriptionCapability(settings);
  syncPdfTranscriptionControls(document, currentPdfTranscriptionCapability);
  let detected = await detectPdfTranscriptionCapability(settings);
  if (token !== pdfTranscriptionCheckToken) return currentPdfTranscriptionCapability;
  if (detected.recommendedModel) {
    const next = { ...settings, transcribe_model: detected.recommendedModel };
    saveSettings({ ...next, api_key: getApiKey(settings) });
    refreshCurrentBrain(next);
    detected = await detectPdfTranscriptionCapability(next);
    if (token !== pdfTranscriptionCheckToken) return currentPdfTranscriptionCapability;
  }
  currentPdfTranscriptionCapability = detected;
  syncPdfTranscriptionControls(document, detected);
  return detected;
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

function handleBranchProviderFailure({ node, error, retry }) {
  const settings = loadSettings();
  if (providerFor(settings.preset).id !== "custom") return;
  showToast({
    message: error?.message || "Couldn't reach the local model.",
    actionLabel: "Troubleshoot",
    timeoutMs: 10000,
    onAction: () => {
      ollamaRecoveryController.open({
        settings: loadSettings(),
        trigger: document.getElementById("t-settings"),
        onResolved: async () => {
          refreshCurrentBrain();
          retry?.();
          showToast({ message: `Retrying "${node?.title || "ask"}".` });
        },
      });
    },
  });
}

async function createLiveAssetData(holeId) {
  const data = {};
  const urls = [];
  try {
    const names = await store.listAssets(holeId);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
      while (next < names.length) {
        const name = names[next++];
        const blob = await store.getAsset(holeId, name);
        if (blob) {
          const url = URL.createObjectURL(blob);
          data[name] = url;
          urls.push(url);
        }
      }
    }));
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
  let disposed = false;
  return {
    data,
    register(name, blob) {
      if (disposed) return;
      if (data[name]) URL.revokeObjectURL(data[name]);
      const url = URL.createObjectURL(blob); data[name] = url; urls.push(url);
      registerRendererAssetName(name);
    },
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

function composerInputMaxHeight() {
  return composerPath === "paste" ? 360 : 240;
}

function isEditableTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable='true']");
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
