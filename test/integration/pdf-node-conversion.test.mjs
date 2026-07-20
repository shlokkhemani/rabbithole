import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRabbithole, answerBranch } from "../../src/node/index.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { defaultFsStore } from "../../src/node/fs-store.js";
import { readAttentionPdfTwoPage } from "../support/attention-pdf.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_MAX_BLOCK_MS = "5000";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-node-convert-"));

async function openPdfSession(name) {
  const filePath = path.join(process.env.RABBITHOLE_DIR, name);
  await fs.writeFile(filePath, await readAttentionPdfTwoPage());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const opened = await openRabbithole({ filePath, signal: controller.signal });
  assert.equal(opened.status, "cancelled");
  return getSession(opened.session_id);
}

function abortAfter(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// ---- full conversion: request shape, redelivery, streamed commits, figures --
{
  const session = await openPdfSession("convert-full.pdf");
  const original = session.nodes.get(session.rootId).markdown;
  const started = await session.handleBrowserEvent({ type: "convert_pdf", node_id: session.rootId });
  assert.equal(started.ok, true);

  const request = await session.waitForEvent();
  assert.equal(request.status, "convert_request");
  assert.equal(request.page_count, 2);
  assert.equal(request.pages.length, 2);
  assert.match(request.rules, /Transcribe/);
  for (const page of request.pages) {
    assert.equal(path.isAbsolute(page.image_path), true);
    const bytes = await fs.readFile(page.image_path);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "conversion pages must be lossless source renders");
  }

  // A keep_listening re-arm must redeliver the unanswered conversion, not drop it.
  const redelivered = await session.waitForEvent();
  assert.equal(redelivered.status, "convert_request");
  assert.equal(redelivered.request_id, request.request_id, "convert_request must survive a waitForEvent re-arm");

  const chunk1 = await answerBranch({ sessionId: session.id, requestId: request.request_id, content: "# Clean Document\n\nFirst half ", partial: true });
  assert.equal(chunk1.partial, true);
  // Second partial exercises the mid-stream state: the node body is now the
  // stream, not the original the provenance offsets were computed against.
  const chunk2 = await answerBranch({ sessionId: session.id, requestId: request.request_id, content: "and second half.\n\n", partial: true });
  assert.equal(chunk2.partial, true);
  assert(session.outboundEvents.some((entry) => entry.data.type === "pdf_convert_progress"), "conversion must stream pdf_convert_progress to the browser");

  // Asks stay locked while the conversion runs — host-side, race-proof.
  await assert.rejects(
    () => session.handleBrowserEvent({ type: "branch_request", request_id: "locked", node_id: "locked-child", parent_id: session.rootId, selected_text: "Attention", question: "?", position: { x: 0, y: 0 } }),
    /being converted/,
  );

  const done = await answerBranch({ sessionId: session.id, requestId: request.request_id, content: "![Euler](figure:page-001:0.2,0.2,0.5,0.3)", signal: abortAfter(150) });
  assert.equal(done.status, "cancelled");

  const node = session.nodes.get(session.rootId);
  assert.match(node.markdown, /# Clean Document\n\nFirst half and second half\./);
  assert.match(node.markdown, /!\[Euler\]\(asset:fig-p001-1\.png\)/, "figure refs must materialize into lossless source crops");
  const pdf = node.extensions.pdf;
  assert.equal(pdf.converted, true);
  assert.equal(pdf.converting, false);
  assert.equal(pdf.pages.length, 2, "conversion must preserve the page stash");
  assert(pdf.lines.length > 0, "conversion must preserve the provenance stash");
  assert.equal(pdf.original_markdown, original, "conversion must stash the original body");
  assert((await defaultFsStore.listAssets(session.holeId)).includes("fig-p001-1.png"));
  session.close("test_done");
  await session.savingChain;
}

// ---- agent disconnect mid-run restores the native document ----------------
{
  const session = await openPdfSession("convert-disconnect.pdf");
  const original = session.nodes.get(session.rootId).markdown;
  await session.handleBrowserEvent({ type: "convert_pdf", node_id: session.rootId });
  const request = await session.waitForEvent();
  await answerBranch({ sessionId: session.id, requestId: request.request_id, content: "# Partial stream that must not survive", partial: true });
  session.setAgentAttached(false, "stalled");
  const node = session.nodes.get(session.rootId);
  assert.equal(node.markdown, original, "disconnect mid-run must restore the original body");
  assert.equal(node.extensions.pdf.converting, false);
  assert.equal(node.extensions.pdf.convert_request, false);
  assert.equal(session.convertRequests.size, 0);
  // Asks are usable again after the restore.
  const branch = await session.handleBrowserEvent({ type: "branch_request", request_id: "after-restore", node_id: "after-restore-child", parent_id: session.rootId, selected_text: "Attention", question: "?", position: { x: 0, y: 0 } });
  assert.equal(branch.ok, true);
  session.close("test_done");
  await session.savingChain;
}

// ---- a convert nobody was listening for survives as a saved request -------
{
  const session = await openPdfSession("convert-saved.pdf");
  const holeId = session.holeId;
  const original = session.nodes.get(session.rootId).markdown;
  await session.handleBrowserEvent({ type: "convert_pdf", node_id: session.rootId });
  const request = await session.waitForEvent();
  await answerBranch({ sessionId: session.id, requestId: request.request_id, content: "# Dirty mid-run body", partial: true });
  await session.flushSave();
  // Simulate a hard crash: the streamed body and converting flags are on disk
  // and no orderly close ever runs a restore.
  session.convertRequests.clear();
  session.close("simulated_crash");
  await session.savingChain;

  const resumed = await openRabbithole({ holeId, signal: abortAfter(4000) });
  assert.equal(resumed.status, "convert_request", "resume must surface the saved conversion");
  assert.equal(resumed.saved, true);
  assert.equal(resumed.pages.length, 2);
  const revived = getSession(resumed.session_id);
  const restoredNode = revived.nodes.get(revived.rootId);
  assert.equal(restoredNode.markdown, original, "resume must restore the original body before re-queuing the convert");

  const finished = await answerBranch({ sessionId: resumed.session_id, requestId: resumed.request_id, content: "# Converted After Resume\n\nAll pages.", signal: abortAfter(150) });
  assert.equal(finished.status, "cancelled");
  assert.equal(revived.nodes.get(revived.rootId).extensions.pdf.converted, true);
  await closeAllSessions("test_done");
  const persisted = await defaultFsStore.loadHole(holeId);
  const persistedRoot = persisted.nodes.find((n) => n.id === persisted.root_id);
  assert.match(persistedRoot.markdown, /Converted After Resume/);
  assert.equal(persistedRoot.extensions.pdf.converted, true);
}

console.log("ok node conversion: convert_request loop, redelivery, ask lock, figures, disconnect restore, and saved-convert rehydration");
