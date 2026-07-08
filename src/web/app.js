import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, defaultBrainSettings, presetFor, settingsForPreset, BRAIN_PRESETS } from "./brain/index.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml } from "../ui/snapshot.js";

const SETTINGS_KEY = "rh-web-settings";
const KEY_KEY = "rh-web-api-key";

const store = new IdbStore();
let memoryKey = "";
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;

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
    <section class="web-top">
      <div>
        <p class="web-kicker">Rabbithole web</p>
        <h1>Local branching canvas</h1>
      </div>
      <button class="web-secondary" id="settings-open" type="button">Settings</button>
    </section>
    <section class="settings-panel" id="settings-panel"></section>
    <section class="new-hole">
      <div class="new-hole-main">
        <input id="new-title" class="web-input" placeholder="Title">
        <textarea id="paste-md" class="paste-md" placeholder="Paste markdown here"></textarea>
        <div class="new-actions">
          <button id="create-hole" class="web-primary" type="button">New Rabbithole</button>
          <label class="drop-md" id="drop-md">
            <input id="file-md" type="file" accept=".md,text/markdown,text/plain">
            <span>Drop a .md file or choose one</span>
          </label>
        </div>
      </div>
    </section>
    <section class="hole-list-wrap">
      <div class="hole-list-head"><h2>Saved holes</h2><button id="refresh-list" class="web-secondary" type="button">Refresh</button></div>
      <div id="hole-list" class="hole-list"></div>
    </section>
  </main><div id="web-toast" class="web-toast" aria-live="polite"></div>`;

  initSettingsPanel();
  document.getElementById("settings-open").addEventListener("click", () => {
    document.getElementById("settings-panel").classList.toggle("expanded");
  });
  document.getElementById("create-hole").addEventListener("click", createFromPaste);
  document.getElementById("refresh-list").addEventListener("click", renderHoleList);
  initDrop();
  await renderHoleList();
}

async function renderHoleList() {
  const listEl = document.getElementById("hole-list");
  if (!listEl) return;
  const holes = await store.listHoles();
  if (!holes.length) {
    listEl.innerHTML = `<div class="empty-state">
      <p>No local holes yet.</p>
      <p class="agent-path">Using a coding agent? <code>claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole</code></p>
    </div>`;
    return;
  }
  listEl.innerHTML = holes.map((hole) => `<article class="hole-row" data-hole="${escapeAttr(hole.hole_id)}">
    <button class="hole-open" type="button">
      <span class="hole-title">${escapeHtml(hole.title || "Untitled")}</span>
      <span class="hole-meta">${escapeHtml(formatDate(hole.updated_at))} · ${hole.node_count} ${hole.node_count === 1 ? "node" : "nodes"}</span>
    </button>
    <button class="hole-delete" type="button" aria-label="Delete ${escapeAttr(hole.title || "Untitled")}">Delete</button>
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
}

async function createFromPaste() {
  const title = document.getElementById("new-title").value.trim();
  const markdown = document.getElementById("paste-md").value.trim();
  if (!markdown) {
    showToast({ message: "Paste markdown first." });
    return;
  }
  const hole = createHoleFromMarkdown({ title, markdown });
  await store.saveHole(hole);
  await startHole(await store.loadHole(hole.hole_id) || hole);
}

function initDrop() {
  const drop = document.getElementById("drop-md");
  const input = document.getElementById("file-md");
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await createFromFile(file);
  });
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
    });
  }
  drop.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
}

async function createFromFile(file) {
  if (!/(\.md$|markdown|text\/plain)/i.test(file.name + " " + file.type)) {
    showToast({ message: "Choose a markdown file." });
    return;
  }
  const markdown = await file.text();
  const title = document.getElementById("new-title").value.trim() || file.name.replace(/\.[^.]+$/, "");
  const hole = createHoleFromMarkdown({ title, markdown });
  await store.saveHole(hole);
  await startHole(await store.loadHole(hole.hole_id) || hole);
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
  startRabbithole(hydration, { transport: currentHost.adapter() });

  document.getElementById("web-home").addEventListener("click", async () => {
    await currentHost?.flushSave();
    history.pushState(null, "", location.pathname);
    location.reload();
  });

  window.__rhWebApp = {
    store,
    exportSnapshotForTest: async () => buildSnapshotHtml(await buildSnapshotHydration()),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => store.readRawHoleForTest(id),
  };
}

function initCanvasSettings() {
  const modal = document.getElementById("web-settings-modal");
  const open = document.getElementById("web-settings");
  const close = document.getElementById("web-settings-close");
  initSettingsPanel();
  open.addEventListener("click", () => {
    modal.hidden = false;
    modal.querySelector("input, select, button")?.focus();
  });
  close.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.hidden = true;
  });
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const settings = loadSettings();
  if (!getApiKey(settings)) panel.classList.add("expanded");
  const presetOptions = Object.values(BRAIN_PRESETS).map((preset) => {
    const label = preset.recommended ? `${preset.label} (recommended)` : preset.label;
    return `<option value="${preset.id}" ${settings.preset === preset.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  panel.innerHTML = `<div class="settings-grid">
    <label>Provider <select id="provider-preset">${presetOptions}</select></label>
    <label>Base URL <input id="provider-base" value="${escapeAttr(settings.base_url || "")}"></label>
    <label>Answer model <input id="answer-model" value="${escapeAttr(settings.answer_model || "")}"></label>
    <label>Author model <input id="author-model" value="${escapeAttr(settings.author_model || "")}"></label>
    <label>API key <input id="api-key" type="password" autocomplete="off" placeholder="sk-..." value="${escapeAttr(getApiKey(settings))}"></label>
    <label class="check-row"><input id="session-only" type="checkbox" ${settings.session_only !== false ? "checked" : ""}> Session only</label>
  </div>
  <div class="key-walkthrough">
    <strong>OpenRouter key in 30 seconds</strong>
    <span>Open openrouter.ai, create a key, paste it here, keep OpenRouter selected, then ask from any selection.</span>
  </div>
  <div class="custom-csp-note">Custom remote origins require editing this static app's CSP. Localhost custom endpoints are allowed by default.</div>
  <button id="save-settings" class="web-primary" type="button">Save settings</button>`;

  panel.querySelector("#provider-preset").addEventListener("change", (event) => {
    const next = settingsForPreset(event.target.value, readSettingsForm());
    panel.querySelector("#provider-base").value = next.base_url;
    panel.querySelector("#answer-model").value = next.answer_model;
    panel.querySelector("#author-model").value = next.author_model;
  });
  panel.querySelector("#save-settings").addEventListener("click", () => {
    const next = readSettingsForm();
    saveSettings(next);
    showToast({ message: "Settings saved." });
    if (currentHost) {
      const key = getApiKey(next);
      currentHost.brain = key || !presetFor(next.preset).requires_key ? createBrain(next, key) : null;
    }
  });
}

function readSettingsForm() {
  const sessionOnly = document.getElementById("session-only")?.checked !== false;
  return {
    preset: document.getElementById("provider-preset")?.value || "openrouter",
    base_url: document.getElementById("provider-base")?.value.trim() || "",
    author_model: document.getElementById("author-model")?.value.trim() || "",
    answer_model: document.getElementById("answer-model")?.value.trim() || "",
    session_only: sessionOnly,
    api_key: document.getElementById("api-key")?.value || "",
  };
}

function loadSettings() {
  try {
    return { ...defaultBrainSettings(), ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
  } catch {
    return defaultBrainSettings();
  }
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

function holeIdFromHash() {
  const match = /^#hole=(.+)$/.exec(location.hash || "");
  return match ? decodeURIComponent(match[1]) : "";
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
