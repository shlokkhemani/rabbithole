import { createRabbitholeUi } from "./composition.js";
import { mountPdfView } from "./pdf-view.js";

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
let runtime = null;
let mermaidPromise = null;

window.addEventListener("message", (event) => {
  let message;
  try {
    message = validateIncomingMessage(event.data);
  } catch (error) {
    showBootError(error);
    return;
  }
  if (message.type === "hydrate") startNora(message.hydration);
  else if (message.type === "error") showBootError(new Error(message.message));
});

postToExtension({ type: "ready" });

/** @param {Record<string, unknown>} hydration */
function startNora(hydration) {
  document.documentElement.classList.add("nora-webview");
  applyNoraChromeLabels();
  if (runtime && !runtime.disposed) void runtime.dispose();
  runtime = createRabbitholeUi({
    hydration,
    host: {
      post: (event) => {
        postToExtension({ type: "uiEvent", event });
        return Promise.resolve({ ok: true });
      },
      refreshStatus: () => {},
      start: () => {},
      flush: () => Promise.resolve(),
      dispose: () => {},
    },
    capabilities: {
      mountPdfView,
      loadMermaid: loadMermaidRuntime,
      exportSnapshot: null,
      exportPortable: null,
    },
  });
}

/** @param {{ type: "ready" } | { type: "uiEvent", event: Record<string, unknown> }} message */
function postToExtension(message) {
  if (!vscode) return;
  if (message.type === "ready") {
    vscode.postMessage({ type: "ready" });
    return;
  }
  if (message.type === "uiEvent" && message.event && typeof message.event.type === "string") {
    vscode.postMessage({ type: "uiEvent", event: message.event });
  }
}

function loadMermaidRuntime() {
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("mermaid.js", document.baseURI).href;
      script.async = true;
      script.addEventListener("load", () => globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error("Mermaid runtime did not initialize")), { once: true });
      script.addEventListener("error", () => reject(new Error("Unable to load Mermaid")), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      mermaidPromise = null;
      throw error;
    });
  }
  return mermaidPromise;
}

function applyNoraChromeLabels() {
  setLabel("t-rail", "Toggle branches");
  setLabel("t-new", "New Nora research");
  setLabel("t-share", "Export");
  setLabel("t-settings", "Profiles");
  const search = document.getElementById("pal-text");
  if (search) search.setAttribute("placeholder", "Search this Nora document...");
  const portable = document.getElementById("sm-portable");
  if (portable) portable.textContent = "Export Nora archive";
}

/** @param {unknown} raw */
function validateIncomingMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("message must be an object");
  const message = /** @type {Record<string, unknown>} */ (raw);
  if (message.type === "error" && typeof message.message === "string") return { type: "error", message: message.message };
  if (message.type !== "hydrate" || !message.hydration || typeof message.hydration !== "object" || Array.isArray(message.hydration)) {
    throw new TypeError("unsupported Nora message");
  }
  return { type: "hydrate", hydration: /** @type {Record<string, unknown>} */ (message.hydration) };
}

/** @param {string} id @param {string} label */
function setLabel(id, label) {
  const element = document.getElementById(id);
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
}

/** @param {unknown} error */
function showBootError(error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.textContent = `Nora could not open this document: ${message}`;
}
