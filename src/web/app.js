import { systemClock } from "../core/clock.js";
import { providerFor, settingsForProvider } from "./provider/provider-registry.js";
import { SETTINGS_KEY, loadSettings, saveSettings } from "./settings/settings.js";
import { getApiKey } from "./settings/credential-store.js";
import { takeBridgeTokenFromFragment } from "./settings/bridge-pairing.js";
import { getGenerationSetupStatus, invalidateGenerationSetup } from "./settings/setup-readiness.js";
import { installTestSeam } from "./test-seam.js";
import { IdbStore } from "./store/idb-store.js";
import { openDialog } from "../ui/primitives/dialog.js";
import { openPopover } from "../ui/primitives/popover.js";
import { escapeHtml } from "../core/utils.js";
import { iconSvg } from "../core/html/icons.js";
import { closestEl } from "../ui/dom.js";
import { isSubmitEnter } from "../ui/input-intent.js";
import { initSettingsSheet, registerSettingsSection } from "../ui/settings-sheet.js";
import { applyTheme, toggleTheme } from "../ui/preferences.js";
import { createWhimsicalHoleId, holeIdFromPathname, pathnameForHole } from "./hole-id.js";
import { getMermaidSource, loadMermaidRuntime } from "./mermaid-runtime.js";
import {
  getDompurifySource,
  getFrozenClientSource,
  getFrozenPdfJsSource,
  getFrozenPdfWorkerSource,
  getFrozenStylesheet,
} from "./snapshot-runtime.js";
import { currentCanvasRuntime, loadCanvasRuntime, warmCanvasRuntime } from "./canvas-runtime-loader.js";
import { mountWebShell } from "./shell/shell.js";
import {
  autoGrowTextarea,
  formatRelativeDate,
  isAuthLikeError,
  isEditableTarget,
  isMarkdownFile,
  isPdfFile,
  isRabbitholeFile,
  isSingleHttpUrl,
  isSnapshotFile,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "./app/utilities.js";

const LAST_HOLE_KEY = "rh-last-hole";
const GITHUB_REPO_API_URL = "https://api.github.com/repos/shlokkhemani/rabbithole";
const GITHUB_STARS_CACHE_KEY = "rh-github-stars-v1";
const GITHUB_STARS_CACHE_TTL = 6 * 60 * 60 * 1000;

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
let settingsRuntimePromise = null;
let settingsWarmScheduled = false;
let workspaceRuntimePromise = null;
let loadedWorkspaceRuntime = null;
let workspaceWarmScheduled = false;
let projectMenuPopover = null;
let githubStarsPromise = null;
let composerPath = "";
let lastHoleCount = 0;
let railSummaries = null;
let toastNotice = null;
let initialBridgePairing = false;
consumeInitialBridgePairing();
let currentPdfTranscriptionCapability = { available: false, status: "checking", model: "", reason: "Checking PDF transcription support…" };
let pdfTranscriptionCheckToken = 0;
const subscriptionModelUnknownRetries = new Set();
const injectedAutoTidyClock = window.__rabbitholeTest?.autoTidyClock || null;

applyInitialWebTheme();

boot().catch((err) => {
  document.body.innerHTML = `<main class="web-fatal"><h1>Rabbithole</h1><p>${escapeHtml(err?.message || String(err))}</p></main>`;
});

function consumeInitialBridgePairing() {
  const pairing = takeBridgeTokenFromFragment();
  if (!pairing?.token) return;
  const paired = settingsForProvider("subscriptions", loadSettings());
  saveSettings({
    ...paired,
    token: pairing.token,
    ...(pairing.port ? { base_url: `http://127.0.0.1:${pairing.port}/v1` } : {}),
  });
  initialBridgePairing = true;
}

async function boot() {
  document.body.classList.add("web-app");
  renderShell();
  initAppChrome();
  initComposer();
  initGlobalDrops();

  const summariesPromise = store.listHoles().then((summaries) => {
    railSummaries = summaries;
    lastHoleCount = summaries.length;
    return summaries;
  });
  const initial = await chooseInitialHole(summariesPromise);
  if (initial) void Promise.all([loadCanvasRuntime(), loadWorkspaceRuntime()]);
  await summariesPromise;
  await renderRail({ refresh: false });
  if (initial) {
    await startHole(initial, { replace: true });
  } else {
    showBlankCanvas();
    warmCanvasRuntime();
    warmWorkspaceRuntime();
  }
  if (initialBridgePairing) beginBridgePairingSetup();
  warmSettingsRuntime();
  installTestSeam({
    store,
    currentHoleId: () => currentHoleId,
    createDocument: createFromComposerDocument,
    waitForCanvasViewSettled: async () => (await loadCanvasRuntime()).whenViewAnimationSettled(),
    selectionAnchorClipBounds: async (element) => {
      const runtime = await loadCanvasRuntime();
      return runtime.anchorClipBounds(element, runtime.overlayViewportRect());
    },
    exportSnapshot: async () => {
      const runtime = await loadCanvasRuntime();
      return runtime.buildSnapshotHtml(await runtime.buildSnapshotProjection());
    },
    exportPortable: async () => {
      await (await loadCanvasRuntime()).flushPendingSaves();
      await currentHost?.flushSave();
      return (await loadWorkspaceRuntime()).buildRabbitholeExport(store, currentHoleId);
    },
    autoTidyClock: injectedAutoTidyClock,
  });
}

function renderShell() {
  toastNotice = mountWebShell();
  railOpen = false;
  applyRailState();
  syncRailPosition();
  requestAnimationFrame(syncRailPosition);
}

async function chooseInitialHole(summariesPromise = store.listHoles()) {
  const pathHole = holeIdFromPathname(location.pathname);
  if (pathHole) {
    return store.loadHole(pathHole);
  }
  const storedId = safeLocalStorageGet(LAST_HOLE_KEY);
  if (storedId) {
    const stored = await store.loadHole(storedId);
    if (stored) return stored;
  }
  const holes = await summariesPromise;
  railSummaries = holes;
  lastHoleCount = holes.length;
  if (!holes.length) return null;
  return store.loadHole(holes[0].hole_id);
}

function initAppChrome() {
  const rail = document.getElementById("web-rail");
  window.addEventListener("resize", syncRailPosition, { passive: true });
  window.addEventListener("popstate", () => { void openHistoryLocation(); });
  // Pairing often lands in a second tab (the terminal link opens a fresh one).
  // Settings are shared through localStorage, so let a tab that is sitting on
  // the "waiting to pair" panel advance the moment another tab pairs.
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    refreshCurrentProvider();
    syncGenerationSetupUi();
    settingsController?.syncSubscriptionStream();
  });
  // Pasting the pairing link into an already-open tab's address bar changes
  // only the hash — no reload, so the load-time consumption never runs.
  window.addEventListener("hashchange", () => {
    initialBridgePairing = false;
    consumeInitialBridgePairing();
    if (!initialBridgePairing) return;
    refreshCurrentProvider();
    beginBridgePairingSetup();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void currentHost?.flushSave();
  });
  window.addEventListener("pagehide", () => {
    // UI node/view updates have their own short debounce before they reach the
    // direct host. Start that flush first so flushSave captures the newest
    // state synchronously, then keep IndexedDB open until both writes settle.
    const uiFlush = currentUi?.flush();
    const hostFlush = currentHost?.flushSave();
    void Promise.allSettled([uiFlush, hostFlush].filter(Boolean)).finally(() => store.close());
  });
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", (event) => requestNewRabbithole({ source: "button", trigger: /** @type {HTMLElement} */ (event.currentTarget) }));
  const projectTrigger = document.getElementById("t-project");
  const projectMenu = document.getElementById("project-menu");
  projectTrigger?.addEventListener("click", () => projectMenuPopover ? closeProjectMenu() : openProjectMenu());
  projectMenu?.addEventListener("click", (event) => {
    if (closestEl(event.target, "a")) closeProjectMenu({ restoreFocus: false });
  });
  projectMenu?.addEventListener("keydown", moveProjectMenuFocus);
  const settingsTrigger = document.getElementById("t-settings");
  /* BYOK is a property of this host, not of the product: the shared sheet ships
     Appearance everywhere and the web app registers Model on top of it. The
     gear itself is wired by the sheet, in both hosts. */
  registerSettingsSection({ id: "model", label: "Model", order: 10, mount: mountModelSettings });
  initSettingsSheet({ hostLabel: "Web" });
  settingsTrigger?.addEventListener("pointerenter", warmSettingsRuntime, { passive: true });
  settingsTrigger?.addEventListener("focus", warmSettingsRuntime, { passive: true });
  document.getElementById("blank-start-new")?.addEventListener("click", (event) => requestNewRabbithole({ source: "button", trigger: /** @type {HTMLElement} */ (event.currentTarget) }));
  document.getElementById("blank-start-setup")?.addEventListener("click", (event) => openModelSetup({ trigger: /** @type {HTMLElement} */ (event.currentTarget) }));
  syncGenerationSetupUi();
  rail?.addEventListener("click", async (event) => {
    const row = closestEl(event.target, ".rail-row");
    if (!row) return;
    const id = row.dataset.hole;
    if (closestEl(event.target, ".rail-delete")) {
      event.preventDefault();
      event.stopPropagation();
      await deleteHoleFromRail(id);
      return;
    }
    if (closestEl(event.target, ".rail-open")) {
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
    // A live hole wires the same button inside the canvas client.
    if (currentHoleId) return;
    toggleTheme();
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
    if (systemClock.now() - cached.updatedAt < GITHUB_STARS_CACHE_TTL) return;
  }
  if (githubStarsPromise) return githubStarsPromise;
  githubStarsPromise = fetch(GITHUB_REPO_API_URL, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const count = Number((await response.json())?.stargazers_count);
    if (!Number.isFinite(count) || count < 0) throw new Error("GitHub returned an invalid star count");
    const value = { count: Math.floor(count), updatedAt: systemClock.now() };
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
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("composer-input"));
  const primary = document.getElementById("composer-primary");
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById("file-md"));

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
    const file = /** @type {DragEvent} */ (event).dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
}

function initGlobalDrops() {
  const viewport = document.getElementById("viewport");
  for (const type of ["dragenter", "dragover"]) {
    viewport.addEventListener(type, (event) => {
      if (currentHoleId || !/** @type {DragEvent} */ (event).dataTransfer?.types?.includes("Files")) return;
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
    const file = /** @type {DragEvent} */ (event).dataTransfer?.files?.[0];
    if (!file) return;
    if (!getGenerationSetupStatus().ready) {
      openModelSetup({ trigger: document.getElementById("blank-start-setup") });
      return;
    }
    openComposer({ source: "drop" });
    await createFromFile(file);
  });
}

/** @param {{source?: string, value?: string, trigger?: HTMLElement | null}} [options] */
function requestNewRabbithole({ source = "button", value = "", trigger } = {}) {
  if (!getGenerationSetupStatus().ready) {
    openModelSetup({ trigger });
    return;
  }
  openComposer({ source, value, trigger });
}

/** @param {{trigger?: HTMLElement | null, status?: string, onReady?: Function | null}} [options] */
async function openModelSetup({ trigger, status = "", onReady = null } = {}) {
  const blankSetup = document.getElementById("blank-start-setup");
  const safeTrigger = trigger instanceof HTMLButtonElement && trigger.disabled ? (blankSetup?.offsetParent !== null ? blankSetup : document.getElementById("t-settings")) : trigger;
  const controller = await loadSettingsController();
  controller.open({ trigger: safeTrigger || document.getElementById("t-settings"), purpose: status ? "recovery" : "setup", status, onReady });
}

/* The user clicked the pairing link the bridge printed. Landing silently on a
   blank canvas would throw the one moment this flow earns away — open the
   panel on the live bridge state and confirm out loud once answers can flow. */
async function beginBridgePairingSetup() {
  const blankSetup = document.getElementById("blank-start-setup");
  const trigger = blankSetup?.offsetParent !== null ? blankSetup : document.getElementById("t-settings");
  const controller = await loadSettingsController();
  controller.beginPairingSetup({
    trigger,
    onComplete: ({ agentLabel, plan }) => {
      showToast({ message: `Connected — answers come from ${agentLabel}${plan ? ` (${plan})` : ""}.` });
    },
  });
}

function syncGenerationSetupUi() {
  const setup = getGenerationSetupStatus();
  const blankNew = document.getElementById("blank-start-new");
  const blankNewWrap = document.getElementById("blank-start-new-wrap");
  const setupButton = document.getElementById("blank-start-setup");
  const status = document.getElementById("blank-start-status");
  if (blankNew) {
    if (setup.ready) blankNew.removeAttribute("aria-describedby");
    else blankNew.setAttribute("aria-describedby", "blank-start-status");
  }
  if (blankNewWrap) blankNewWrap.toggleAttribute("data-setup-required", !setup.ready);
  if (setupButton) setupButton.textContent = setup.ready ? "Model settings" : "Set up AI";
  if (status) status.hidden = setup.ready;
}

/** @param {{source?: string, value?: string, trigger?: HTMLElement | null}} [options] */
function openComposer({ source = "button", value = "", trigger } = {}) {
  if (!getGenerationSetupStatus().ready) {
    openModelSetup({ trigger });
    return;
  }
  const modal = document.getElementById("composer-modal");
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("composer-input"));
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
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("composer-input"));
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
  /** @type {HTMLTextAreaElement} */ (document.getElementById("composer-input")).value = "";
  document.getElementById("composer-card").focus({ preventScroll: true });
}

async function runComposer() {
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("composer-input"));
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
    const hole = (await loadWorkspaceRuntime()).createPendingHoleFromQuestion(question);
    await store.saveHole(hole);
    setIngestStatus("Opening Rabbithole...", "busy");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    const message = err?.message || String(err);
    if (isAuthLikeError(err)) {
      invalidateGenerationSetup();
      syncGenerationSetupUi();
      const controller = await loadSettingsController();
      controller.open({ trigger: document.getElementById("t-settings"), purpose: "recovery", status: message, onReady: action, focusKey: true });
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
    const { hole } = await (await loadWorkspaceRuntime()).openUrlToStoredHole({
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
    const imported = await (await loadWorkspaceRuntime()).importSnapshotFile(store, file, { mintHoleId: createWhimsicalHoleId });
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
    const imported = await (await loadWorkspaceRuntime()).importRabbitholeFile(store, file, { mintHoleId: createWhimsicalHoleId });
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
    const runtime = await loadWorkspaceRuntime();
    const { hole } = await runtime.ingestPdfToStoredHole({
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
    const runtime = await loadWorkspaceRuntime().catch(() => null);
    setIngestStatus(runtime ? runtime.describePdfImportFailure(err) : (err?.message || String(err)), "error");
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
  const runtime = await loadWorkspaceRuntime();
  const hole = runtime.createHoleFromMarkdown({ title, markdown, baseUrl });
  if (!improveStructure) {
    await store.saveHole(hole);
    return hole;
  }
  const settings = loadSettings();
  const key = getApiKey(settings);
  setIngestStatus("Improving structure with the model...", "busy");
  const provider = runtime.createProvider(settings, key);
  const root = hole.nodes[0];
  root.status = "pending";
  root.markdown = "";
  const host = new runtime.DirectRabbitholeHost({ store, hole, provider });
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
  const [canvasRuntime, workspaceRuntime] = await Promise.all([loadCanvasRuntime(), loadWorkspaceRuntime()]);
  await disposeCurrentHole();
  resetHoleSurface();
  currentHoleId = hole.hole_id;
  document.body.classList.remove("web-blank-canvas");
  document.getElementById("blank-start").hidden = true;
  closeComposerSilently();
  safeLocalStorageSet(LAST_HOLE_KEY, hole.hole_id);
  const holePath = `${pathnameForHole(hole.hole_id)}${location.hash}`;
  if (replace) history.replaceState(null, "", holePath);
  else history.pushState(null, "", holePath);

  canvasRuntime.setSnapshotHooks({
    fetchAssetBinary: async (name) => store.getAsset(currentHoleId, name),
    getSnapshotHole: async () => {
      await currentHost.flushSave();
      return store.loadHole(currentHoleId);
    },
    getFrozenClientSource,
    getDompurifySource,
    getPdfWorkerSource: getFrozenPdfWorkerSource,
    getPdfJsSource: getFrozenPdfJsSource,
    getMermaidSource,
    getStylesheetText: getFrozenStylesheet,
  });

  if (hole.nodes?.some((node) => node?.extensions?.pdf?.version === 2 && !node.extensions.pdf.converted)) {
    await refreshPdfTranscriptionCapability();
  } else {
    currentPdfTranscriptionCapability = workspaceRuntime.pdfTranscriptionCapability(loadSettings());
  }
  const settings = loadSettings();
  const provider = providerForSettings(settings);
  const host = new workspaceRuntime.DirectRabbitholeHost({
    store,
    hole,
    provider,
    providerRequiredError: providerRequiredErrorForSettings(settings),
    registerAssetUrl: (name, blob) => currentAssetLease?.register(name, blob),
    revokeAssetUrl: (name) => currentAssetLease?.revoke(name),
    onToast: (notice) => { if (currentHost === host) showToast(notice); },
    onDone: async () => {
      if (currentHost !== host) return;
      await host.flushSave();
      history.replaceState(null, "", `${location.pathname}${location.hash}`);
      location.reload();
    },
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
    currentUi = canvasRuntime.startRabbithole(hydration, {
      clock: injectedAutoTidyClock,
      transport: host.adapter(),
      exportPortable: exportCurrentRabbithole,
      loadMermaid: loadMermaidRuntime,
      getPdfTranscriptionCapability: () => currentPdfTranscriptionCapability,
    });
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
  history.replaceState(null, "", `${location.pathname}${location.search}${location.hash}`);
  document.getElementById("blank-start").hidden = false;
  syncGenerationSetupUi();
}

async function exportCurrentRabbithole() {
  await (await loadCanvasRuntime()).flushPendingSaves();
  await currentHost?.flushSave();
  if (!currentHoleId) throw new Error("No open Rabbithole to export.");
  const runtime = await loadWorkspaceRuntime();
  const payload = await runtime.downloadRabbitholeExport(store, currentHoleId);
  return { filename: runtime.rabbitholeFilename(payload.hole?.title), payload };
}

async function renderRail({ refresh = true, firstHoleId = null } = {}) {
  const rail = document.getElementById("web-rail");
  if (!rail) return;
  if (refresh || !railSummaries) railSummaries = await store.listHoles();
  const summaries = firstHoleId
    ? [...railSummaries].sort((a, b) => Number(b.hole_id === firstHoleId) - Number(a.hole_id === firstHoleId))
    : railSummaries;
  lastHoleCount = summaries.length;
  let inner = rail.querySelector(":scope > .rail-inner");
  let list = inner?.querySelector(":scope > .rail-list");
  if (!inner || !list) {
    inner = document.createElement("div"); inner.className = "rail-inner";
    list = document.createElement("div"); list.className = "rail-list"; list.id = "rail-list";
    inner.appendChild(list); rail.replaceChildren(inner);
  }
  const rows = new Map(Array.from(/** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll(".rail-row")), (row) => [row.dataset.hole, row]));
  const next = summaries.map((summary) => {
    const row = rows.get(summary.hole_id) || createRailRow(summary.hole_id);
    patchRailRow(row, summary);
    return row;
  });
  if (!next.length) {
    const empty = list.querySelector(".rail-empty") || document.createElement("div");
    empty.className = "rail-empty"; empty.textContent = "No Rabbitholes yet."; next.push(empty);
  }
  reconcileChildren(list, next);
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
  row.classList.toggle("current", summary.hole_id === currentHoleId);
  const titleNode = row.querySelector(".rail-title");
  if (titleNode.textContent !== title) titleNode.textContent = title;
  const open = row.querySelector(".rail-open");
  if (open.getAttribute("aria-label") !== title) open.setAttribute("aria-label", title);
  const updated = formatRelativeDate(summary.updated_at);
  if (open.title !== updated) open.title = updated;
  const remove = row.querySelector(".rail-delete");
  const removeLabel = `Delete ${title}`;
  if (remove.getAttribute("aria-label") !== removeLabel) remove.setAttribute("aria-label", removeLabel);
}

function reconcileChildren(parent, next) {
  const retained = new Set(next);
  for (const child of Array.from(parent.children)) {
    if (!retained.has(child)) child.remove();
  }
  let cursor = parent.firstChild;
  for (const child of next) {
    if (child === cursor) {
      cursor = cursor.nextSibling;
    } else {
      parent.insertBefore(child, cursor);
    }
  }
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
  const assets = typeof store.getAssets === "function"
    ? await store.getAssets(holeId)
    : await Promise.all((await store.listAssets(holeId)).map(async (name) => ({ name, blob: await store.getAsset(holeId, name) })));
  await store.deleteHole(holeId);
  if (safeLocalStorageGet(LAST_HOLE_KEY) === holeId) localStorage.removeItem(LAST_HOLE_KEY);
  await renderRail();
  showToast({
    message: `Deleted "${hole.title || "Untitled"}"`,
    actionLabel: "Undo",
    timeoutMs: 10000,
    onAction: async () => {
      await store.saveHole(hole);
      const restorableAssets = assets.filter((asset) => asset.blob);
      if (typeof store.putAssets === "function") await store.putAssets(holeId, restorableAssets);
      else await Promise.all(restorableAssets.map((asset) => store.putAsset(holeId, asset.name, asset.blob)));
      await renderRail();
    },
  });
  if (deletingCurrent) {
    const next = railSummaries?.[0];
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

function refreshCurrentProvider(settings = loadSettings()) {
  if (!currentHost) return;
  currentHost.provider = providerForSettings(settings);
  currentHost.providerRequiredError = providerRequiredErrorForSettings(settings);
}

function providerForSettings(settings) {
  const runtime = loadedWorkspaceRuntime;
  if (!runtime) return null;
  const preset = providerFor(settings.preset);
  const key = preset.id === "subscriptions" ? String(settings.token || "").trim() : getApiKey(settings);
  if (preset.requires_key && !key) return null;
  if (preset.id === "subscriptions" && !key) return null;
  if (preset.requires_base_url && !runtime.isHttpUrl(settings.base_url)) return null;
  if (!String(settings.model || preset.model || "").trim()) return null;
  return runtime.createProvider(settings, key);
}

function providerRequiredErrorForSettings(settings) {
  return providerFor(settings.preset).id === "subscriptions"
    ? { message: "Connect your Claude or ChatGPT plan to keep asking.", code: "subscription_unpaired" }
    : null;
}

function currentHoleNeedsPdfTranscription() {
  if (!currentHost) return false;
  for (const node of currentHost.state.nodes.values()) {
    if (node?.extensions?.pdf?.version === 2 && !node.extensions.pdf.converted) return true;
  }
  return false;
}

async function refreshPdfTranscriptionCapability(settings = loadSettings()) {
  const runtime = await loadWorkspaceRuntime();
  const token = ++pdfTranscriptionCheckToken;
  currentPdfTranscriptionCapability = runtime.pdfTranscriptionCapability(settings);
  const { syncPdfTranscriptionControls } = await loadCanvasRuntime();
  syncPdfTranscriptionControls(document, currentPdfTranscriptionCapability);
  let detected = await runtime.detectPdfTranscriptionCapability(settings);
  if (token !== pdfTranscriptionCheckToken) return currentPdfTranscriptionCapability;
  if (detected.recommendedModel) {
    const next = { ...settings, transcribe_model: detected.recommendedModel };
    saveSettings({ ...next, api_key: getApiKey(settings) });
    refreshCurrentProvider(next);
    detected = await runtime.detectPdfTranscriptionCapability(next);
    if (token !== pdfTranscriptionCheckToken) return currentPdfTranscriptionCapability;
  }
  currentPdfTranscriptionCapability = detected;
  syncPdfTranscriptionControls(document, detected);
  return detected;
}

async function handleBranchAuthRequired({ node, error, retry }) {
  const settings = loadSettings();
  const controller = await loadSettingsController();
  if (providerFor(settings.preset).id === "subscriptions") {
    controller.open({
      trigger: document.getElementById("t-settings"),
      purpose: "recovery",
      onReady: () => retryBranch(node, retry),
    });
    controller.showBridgeUnauthorized({ onReady: () => retryBranch(node, retry) });
    return;
  }
  invalidateGenerationSetup();
  syncGenerationSetupUi();
  controller.open({
    trigger: document.getElementById("t-settings"),
    purpose: "recovery",
    status: error?.message || "Reconnect your model to continue.",
    focusKey: providerFor(loadSettings().preset).requires_key,
    onReady: () => retryBranch(node, retry),
  });
}

async function handleBranchProviderFailure({ node, error, retry }) {
  const settings = loadSettings();
  if (providerFor(settings.preset).id === "subscriptions") {
    const controller = await loadSettingsController();
    const runtime = await loadWorkspaceRuntime();
    const agentId = settings.agent === "claude" || settings.agent === "codex"
      ? settings.agent
      : runtime.bridgeAgentOf(settings.model) || "claude";
    const label = runtime.BRIDGE_AGENT_LABELS[agentId];
    if (error?.code === "model_unknown") {
      if (!subscriptionModelUnknownRetries.has(node.id) && controller.recoverUnknownModel(agentId)) {
        subscriptionModelUnknownRetries.add(node.id);
        retryBranch(node, retry);
      }
      return;
    }
    if (error?.code === "model_no_images") {
      showToast({
        message: `${label} cannot use this image with the selected model.`,
        actionLabel: "Ask text-only",
        timeoutMs: 10000,
        onAction: () => retryBranch(node, () => retry?.({ withoutAttachment: true })),
      });
      return;
    }
    if (error?.code === "turn_failed") {
      showToast({
        message: `${label} could not finish the answer.`,
        actionLabel: `Retry with ${label}`,
        timeoutMs: 10000,
        onAction: () => retryBranch(node, retry),
      });
      return;
    }
    if (error?.code === "payload_too_large") return;
    if (error?.code === "agent_signed_out" || error?.code === "agent_missing") {
      controller.recoverBridgeAgent(agentId, {
        trigger: document.getElementById("t-settings"),
        onReady: () => retryBranch(node, retry),
      });
      return;
    }
    showToast({ message: `${label} stopped responding.` });
    return;
  }
  if (providerFor(settings.preset).id !== "local") return;
  showToast({
    message: error?.message || "Couldn't reach the local model.",
    actionLabel: "Troubleshoot",
    timeoutMs: 10000,
    onAction: async () => {
      const recovery = await loadOllamaRecoveryController();
      recovery.open({
        settings: loadSettings(),
        trigger: document.getElementById("t-settings"),
        onResolved: () => retryBranch(node, retry),
      });
    },
  });
}

function mountModelSettings(host) {
  let active = true;
  let dispose = null;
  void loadSettingsController().then((controller) => {
    if (!active) return;
    dispose = controller.mountPane(host) || null;
  }).catch((error) => {
    if (active) host.textContent = error?.message || "Model settings are unavailable.";
  });
  return () => {
    active = false;
    dispose?.();
  };
}

function loadSettingsRuntime() {
  if (!settingsRuntimePromise) {
    settingsRuntimePromise = import("./settings/settings-runtime.js").then(({ createWebSettingsRuntime }) => {
      const runtime = createWebSettingsRuntime({
        onOllamaResolved: async ({ model, transcribeModel }) => {
          const current = loadSettings();
          saveSettings({ ...current, model, transcribe_model: transcribeModel, api_key: getApiKey(current) });
          settingsController?.completeLocalSetup?.();
          refreshCurrentProvider();
          syncGenerationSetupUi();
          if (currentHoleNeedsPdfTranscription()) await refreshPdfTranscriptionCapability();
        },
        onSettingsChange: () => {
          refreshCurrentProvider();
          syncGenerationSetupUi();
          if (currentHoleNeedsPdfTranscription()) void refreshPdfTranscriptionCapability();
          else void loadWorkspaceRuntime().then((runtime) => {
            currentPdfTranscriptionCapability = runtime.pdfTranscriptionCapability(loadSettings());
          }).catch(() => {});
        },
      });
      settingsController = runtime.controller;
      ollamaRecoveryController = runtime.recovery;
      settingsController.syncSubscriptionStream();
      return runtime;
    }).catch((error) => {
      settingsRuntimePromise = null;
      settingsController = null;
      ollamaRecoveryController = null;
      throw error;
    });
  }
  return settingsRuntimePromise;
}

async function loadSettingsController() {
  return (await loadSettingsRuntime()).controller;
}

async function loadOllamaRecoveryController() {
  return (await loadSettingsRuntime()).recovery;
}

function warmSettingsRuntime() {
  if (settingsController || settingsRuntimePromise || settingsWarmScheduled) return;
  settingsWarmScheduled = true;
  const warm = () => {
    settingsWarmScheduled = false;
    void loadSettingsRuntime().catch(() => {});
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 1200 });
  else setTimeout(warm, 0);
}

function loadWorkspaceRuntime() {
  if (!workspaceRuntimePromise) {
    workspaceRuntimePromise = import("./workspace-runtime.js").then((runtime) => {
      loadedWorkspaceRuntime = runtime;
      return runtime;
    }).catch((error) => {
      workspaceRuntimePromise = null;
      loadedWorkspaceRuntime = null;
      throw error;
    });
  }
  return workspaceRuntimePromise;
}

function warmWorkspaceRuntime() {
  if (loadedWorkspaceRuntime || workspaceRuntimePromise || workspaceWarmScheduled) return;
  workspaceWarmScheduled = true;
  const warm = () => {
    workspaceWarmScheduled = false;
    void loadWorkspaceRuntime().catch(() => {});
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 1200 });
  else setTimeout(warm, 0);
}

function retryBranch(node, retry) {
  refreshCurrentProvider();
  retry?.();
  showToast({ message: `Retrying "${node?.title || "ask"}".` });
}

async function createLiveAssetData(holeId) {
  const data = {};
  const urls = [];
  try {
    // One IndexedDB transaction returns Blob handles for the complete lease.
    // Opening an asset-heavy hole should not pay one transaction per image.
    const assets = typeof store.getAssets === "function"
      ? await store.getAssets(holeId)
      : await Promise.all((await store.listAssets(holeId)).map(async (name) => ({ name, blob: await store.getAsset(holeId, name) })));
    for (const { name, blob } of assets) {
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      data[name] = url;
      urls.push(url);
    }
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
      currentCanvasRuntime()?.registerRendererAssetName(name);
    },
    revoke(name) {
      if (disposed || !data[name]) return;
      URL.revokeObjectURL(data[name]);
      delete data[name];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    },
  };
}

/** @param {{message?: string, actionLabel?: string, timeoutMs?: number, onAction?: Function | null}} [options] */
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

function composerInputMaxHeight() {
  return composerPath === "paste" ? 360 : 240;
}

function applyInitialWebTheme() {
  try { applyTheme(); } catch {}
}
