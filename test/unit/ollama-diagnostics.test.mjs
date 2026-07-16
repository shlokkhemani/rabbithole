import assert from "node:assert/strict";
import { diagnoseOllama, ollamaUrls } from "../../src/web/brain/ollama-diagnostics.js";
import { OLLAMA_ORIGIN_COMMANDS } from "../../src/web/settings/ollama-recovery.js";

const originalFetch = globalThis.fetch;
const originalNavigator = globalThis.navigator;

try {
  setPermission("prompt");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not fetch"); };
  assert.equal((await diagnoseOllama("http://localhost:11434/v1")).status, "permission_prompt");
  assert.equal(calls, 0, "passive diagnosis must not trigger a browser permission prompt");

  setPermission("denied");
  assert.equal((await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true })).status, "permission_denied");

  setPermission("granted");
  globalThis.fetch = async (_url, options) => {
    if (options.mode === "no-cors") return new Response("forbidden", { status: 403 });
    throw new TypeError("Failed to fetch");
  };
  assert.equal((await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true })).status, "origin_blocked", "an opaque-reachable endpoint with unreadable CORS should get the origin guide");
  assert.match(OLLAMA_ORIGIN_COMMANDS, /killall Ollama[\s\S]*killall ollama[\s\S]*open -na \/Applications\/Ollama\.app/, "origin recovery should reliably stop both Ollama processes and launch a fresh app instance");
  assert.doesNotMatch(OLLAMA_ORIGIN_COMMANDS, /osascript/, "origin recovery should not use Ollama's cancellable AppleScript quit flow");

  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal((await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true })).status, "unreachable", "a failed opaque probe should get the install/start guide");

  globalThis.fetch = async (url, options = {}) => {
    if (options.mode === "no-cors") return new Response(null, { status: 200 });
    if (url.endsWith("/api/version")) return Response.json({ version: "0.24.0" });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gemma3:4b" }] });
    if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "vision"] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const ready = await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.models, [{ id: "gemma3:4b", name: "gemma3:4b", capabilities: ["completion", "vision"], vision: true }]);
  assert.deepEqual(ollamaUrls("http://localhost:11434/v1/"), {
    openAiBase: "http://localhost:11434/v1",
    version: "http://localhost:11434/api/version",
    pull: "http://localhost:11434/api/pull",
  });

  setPermission("prompt");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal((await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true })).status, "unreachable", "opaque probes are not permission-gated, so a stopped Ollama must never present as a permission prompt");

  globalThis.fetch = async (_url, options) => {
    if (options.mode === "no-cors") return new Response(null, { status: 200 });
    throw new TypeError("Failed to fetch");
  };
  assert.equal((await diagnoseOllama("http://localhost:11434/v1", { requestPermission: true })).status, "permission_prompt", "a readable probe blocked while the permission is undecided is a permission problem, not an Ollama origin problem");

  console.log("ok Ollama diagnostics: permission, reachability, origin, and ready states");
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
}

function setPermission(state) {
  Object.defineProperty(globalThis, "navigator", {
    value: { permissions: { query: async () => ({ state }) } },
    configurable: true,
    writable: true,
  });
}
