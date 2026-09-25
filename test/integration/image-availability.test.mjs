/** @protects generate_image discovery gated on the AI images setting and Codex readiness. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const FIXTURE = path.join(ROOT, "test/integration/fixtures/fake-codex-image.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-image-availability-"));

try {
  await expectImages("setting on, Codex signed in", { setting: "on" }, true);
  await expectImages("setting on, Codex signed out", { setting: "on", env: { FAKE_CODEX_IMAGE_LOGIN: "signed_out" } }, false);
  await expectImages("setting on, Codex missing", { setting: "on", env: { RABBITHOLE_CODEX_BIN: path.join(tmp, "no-codex") } }, false);
  await expectImages("setting off, Codex signed in", {}, false);
  console.log("ok image availability: generate_image needs the setting on and Codex installed and signed in");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

/** @param {string} label @param {{setting?: string, env?: Record<string, string>}} options @param {boolean} expected */
async function expectImages(label, { setting, env = {} }, expected) {
  const dir = await fs.mkdtemp(path.join(tmp, "case-"));
  if (setting) {
    await fs.writeFile(path.join(dir, "preferences.json"), JSON.stringify({ version: 1, values: { "rh-ai-images": setting } }), "utf8");
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "bin/mcp-server.js")],
    cwd: ROOT,
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: dir,
      RABBITHOLE_DIR: dir,
      RABBITHOLE_NO_BROWSER: "1",
      RABBITHOLE_CODEX_BIN: FIXTURE,
      ...env,
    },
  });
  const client = new Client({ name: "image-availability", version: "1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.some((tool) => tool.name === "generate_image"), expected, `${label}: generate_image listed`);
    assert.equal(tools.find((tool) => tool.name === "answer_branch")?.description.includes("generate_image"), expected,
      `${label}: answer_branch image guidance`);
    assert.equal(client.getInstructions()?.includes("generate_image"), expected, `${label}: server instructions image guidance`);
  } finally {
    await client.close();
  }
}
