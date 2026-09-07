#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
if (args[0] !== "exec") process.exit(2);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", run);
process.on("SIGTERM", () => process.exit(0));

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function run() {
  const resumed = args[1] === "resume";
  const threadId = resumed ? args[2] : `image-thread-${process.pid}`;
  const home = process.env.CODEX_HOME;
  const logPath = process.env.FAKE_CODEX_IMAGE_LOG || path.join(home, "fake-codex-image-log.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({ argv: args, CODEX_HOME: home, stdin, pid: process.pid }));

  const mode = process.env.FAKE_CODEX_IMAGE_MODE || "ok";
  emit({ type: "thread.started", thread_id: threadId });
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "signed_out") {
    emit({ type: "error", message: "Login required: Codex is signed out" });
    process.exitCode = 1;
    return;
  }
  if (mode === "quota") {
    emit({ type: "turn.failed", error: { message: "Image usage limit reached", resets_at: "2026-09-08T00:00:00Z" } });
    process.exitCode = 1;
    return;
  }
  if (mode !== "nopng") {
    const outputDir = path.join(home, "generated_images", threadId);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "item.png"), tinyPng(2, 3));
  }
  emit({ type: "item.completed", item: { type: "agent_message", text: "I will draw a labelled diagram." } });
  emit({ type: "item.completed", item: { type: "agent_message", text: "DONE" } });
  emit({ type: "turn.completed" });
}

function tinyPng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.alloc(1 + width * 4));
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), output.length - 4);
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
