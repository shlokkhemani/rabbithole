/** @protects cross-session reader preference persistence and same-session sync capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCanvasHtml } from "../../src/node/mcp/http/page.js";
import { RabbitholeSession } from "../../src/node/mcp/hole-session/session.js";
import { buildSessionExportHtml } from "../support/session-export.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
const previousDir = process.env.RABBITHOLE_DIR;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-preferences-persistence-"));
process.env.RABBITHOLE_DIR = dir;
const customTheme = "magenta-secret-preference";

function createSession(id) {
  return new RabbitholeSession({
    holeId: "preference-hole-" + id,
    title: "Preference session " + id,
    rootId: "root",
    nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Body", status: "answered" }],
    assetNames: new Set(),
    isResume: false,
    renderPage: buildCanvasHtml,
  });
}

async function post(session, values) {
  const response = await fetch(session.url + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "preferences_patch", values }),
  });
  assert.equal(response.status, 200, await response.text());
}

async function readPreferenceEvent(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    const match = /data: (.+)\n\n/.exec(text);
    if (match) return JSON.parse(match[1]);
  }
  throw new Error("preference SSE event did not arrive: " + text);
}

const first = createSession("a");
const second = createSession("b");
const firstAbort = new AbortController();
const secondAbort = new AbortController();

try {
  await first.start();
  const initialPage = await (await fetch(first.url)).text();
  assert.match(initialPage, /"preferences":\{\}/, "the MCP page explicitly configures even an empty machine seed");

  const firstStream = await fetch(first.url + "/sse?after=0", { signal: firstAbort.signal });
  const secondStream = await fetch(first.url + "/sse?after=0", { signal: secondAbort.signal });
  assert.equal(first.sseClients.size, 2, "both canvas tabs are connected before the patch");
  const secondEvent = readPreferenceEvent(secondStream.body.getReader());

  await post(first, { "rh-theme": customTheme, "rh-auto-tidy": "on" });
  assert.deepEqual(await secondEvent, {
    type: "preferences",
    values: { "rh-theme": customTheme, "rh-auto-tidy": "on" },
  }, "the second SSE client receives the same-session preference patch");

  await second.start();
  assert.notEqual(first.url, second.url, "the persistence proof crosses two random-port origins");
  const nextPage = await (await fetch(second.url)).text();
  assert(nextPage.includes('"rh-theme":"' + customTheme + '"'), "the next session page carries the machine seed");
  assert(nextPage.includes('"rh-auto-tidy":"on"'));

  assert.equal(JSON.stringify(second.buildHydration()).includes(customTheme), false,
    "engine hydration never acquires the page-only seed");
  const snapshot = await (await fetch(second.url + "/snapshot-hole")).text();
  assert.equal(snapshot.includes(customTheme), false, "snapshot JSON never carries preference values");
  const exported = await buildSessionExportHtml(second);
  assert.equal(exported.includes(customTheme), false, "frozen export HTML never carries preference values");
  firstStream.body.cancel().catch(() => {});
} finally {
  firstAbort.abort();
  secondAbort.abort();
  await Promise.all([first.close("preferences_persistence_complete"), second.close("preferences_persistence_complete")]);
  if (previousDir === undefined) delete process.env.RABBITHOLE_DIR;
  else process.env.RABBITHOLE_DIR = previousDir;
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("cross-session reader preference persistence ok");
