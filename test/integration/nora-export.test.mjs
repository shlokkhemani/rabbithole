import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { addBytesAttachmentToDocument } from "../../src/extension/attachments.js";
import { exportMarkdownDocument, exportSnapshotDocument } from "../../src/extension/commands/export-commands.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("Nora export commands write Markdown and self-contained snapshots without mutating the document", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "export.nora")), {
      tempRoot: dir,
      title: "Export Research",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "export-doc",
    });
    const attachment = await addBytesAttachmentToDocument(document, Buffer.from("image bytes"), {
      title: "Diagram",
      filename: "diagram.png",
      mediaType: "image/png",
      now: "2026-07-28T00:00:01.000Z",
      idFactory: idFactory(["image", "image"]),
    });
    await document.commitEvent({
      type: "node_answered",
      node_id: "root",
      title: "Export Research",
      markdown: `Visible export body.\n\n![Diagram](asset:${attachment.assetName})`,
      read: true,
    });
    await document.commitEvent({
      type: "node_references",
      node_id: "root",
      source_ids: [attachment.source.id],
      evidence_ids: [attachment.evidence.id],
      attachment_ids: [attachment.attachment.id],
    });
    const revisionBefore = document.revision;
    const api = fakeVscodeApi();
    const context = { extensionUri: fileUri(process.cwd()) };

    const markdownPath = path.join(dir, "research.md");
    const markdownResult = await exportMarkdownDocument(context, api, document, { destination: fileUri(markdownPath) });
    assert.equal(await fs.readFile(markdownPath, "utf8"), markdownResult.markdown);
    assert(markdownResult.markdown.includes("Visible export body."));
    assert(markdownResult.markdown.includes("[^evidence-image]"));

    const snapshotPath = path.join(dir, "research.html");
    const snapshotResult = await exportSnapshotDocument(context, api, document, {
      destination: fileUri(snapshotPath),
      bundle: testSnapshotBundle(),
    });
    const html = await fs.readFile(snapshotPath, "utf8");
    assert.equal(html, snapshotResult.html);
    assert(html.includes("application/vnd.nora+json"));
    assert(html.includes(Buffer.from("image bytes").toString("base64")), "snapshot embeds referenced asset bytes");
    assert(html.includes("nora-snapshot-evidence"), "snapshot includes stable evidence section");
    assert.equal(document.revision, revisionBefore, "exports do not mutate the .nora document");

    const failedRevision = document.revision;
    await assert.rejects(
      exportMarkdownDocument(context, api, document, {
        destination: fileUri(path.join(dir, "fail.md")),
        writeFile: async () => { throw new Error("disk full"); },
        rethrow: true,
      }),
      /disk full/,
    );
    assert.equal(document.revision, failedRevision, "failed destination writes do not mutate the document");
    assert(api.errors.some((message) => message.includes("disk full")));
    await document.dispose();
  });
});

function testSnapshotBundle() {
  return {
    stylesheetText: "#world{} #nora-snapshot-evidence{}",
    dompurifySource: "globalThis.DOMPurify={sanitize:function(value){return value}};",
    frozenClientSource: "globalThis.NoraFrozenClient={startPortableSnapshot:function(){}};",
  };
}

function fakeVscodeApi() {
  const api = {
    errors: [],
    window: {
      showSaveDialog: async () => null,
      showErrorMessage: async (message) => { api.errors.push(String(message)); },
      showInformationMessage: async () => null,
    },
    workspace: {
      fs: {
        writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
        readFile: async (uri) => fs.readFile(uri.fsPath),
      },
    },
    Uri: {
      file: fileUri,
      joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
    },
  };
  return api;
}

/** @param {string[]} values */
function idFactory(values) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

/** @param {string} filePath */
function fileUri(filePath) {
  const absolute = path.resolve(filePath);
  return {
    scheme: "file",
    fsPath: absolute,
    toString: () => pathToFileURL(absolute).href,
  };
}
