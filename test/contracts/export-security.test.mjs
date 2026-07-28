import assert from "node:assert/strict";
import test from "node:test";
import { createMarkdownExport } from "../../src/core/markdown-export.js";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import {
  createNoraSnapshotProjection,
  snapshotProjectionToFrozenHydration,
} from "../../src/core/snapshot-projection.js";
import { noraDocumentFixture } from "../fixtures/contracts/document-fixture.js";

const HIDDEN = "SECRET_HIDDEN_EXPORT_SENTINEL";
const VISIBLE = "VISIBLE_RESEARCH_EXPORT_SENTINEL";

test("Nora exports include visible research and omit hidden run/profile/config fields", () => {
  const document = withExportSentinels();
  const projection = createNoraSnapshotProjection(document, document.viewState, {
    "figure.png": Buffer.from("referenced image").toString("base64"),
    "unused.png": Buffer.from("unused image").toString("base64"),
  });
  const html = buildSnapshotHtml({
    title: document.title,
    stylesheetText: "#world{} #nora-snapshot-evidence{}",
    dompurifySource: "globalThis.DOMPurify={sanitize:function(value){return value}};",
    mermaidSource: "globalThis.mermaid={};",
    frozenClientSource: "globalThis.NoraFrozenClient={startPortableSnapshot:function(){}};",
    snapshotProjection: projection,
  });
  const markdown = createMarkdownExport(document);
  const serializedProjection = JSON.stringify(projection);

  assert(serializedProjection.includes(VISIBLE), "snapshot keeps visible node Markdown");
  assert(markdown.includes(VISIBLE), "Markdown keeps visible node Markdown");
  assert(!serializedProjection.includes(HIDDEN), "snapshot omits hidden configuration, run, and extension fields");
  assert(!markdown.includes(HIDDEN), "Markdown omits hidden configuration, run, and extension fields");
  assert.deepEqual(Object.keys(projection.assets), ["figure.png"], "snapshot embeds referenced assets only");
  assert.equal(projection.document.selectedProfileId, null);
  assert.deepEqual(projection.document.runs, []);
  assert.deepEqual(projection.document.nodes[0].extensions, {}, "snapshot clears non-renderer check state");
  assert.deepEqual(projection.document.checks[0].state, {}, "Markdown/snapshot start checks clean");
  assert(html.includes("https://github.com/r13v/Nora/blob/"), "snapshot exposes stable evidence links");
  assert(!html.includes("</script><script>globalThis.__breakout"), "snapshot payload is inert text, not executable markup");
  assert(markdown.includes("[^evidence-code-nora]"), "Markdown emits evidence footnotes");
  assert(markdown.includes("commit 0123456789abcdef0123456789abcdef01234567"), "Markdown keeps source revision evidence");

  const hydration = snapshotProjectionToFrozenHydration(projection);
  assert.equal(hydration.frozen, true);
  assert.equal(hydration.asset_data["figure.png"].startsWith("data:image/png;base64,"), true);
  assert.equal(hydration.nora.selectedProfileId, undefined);
});

function withExportSentinels() {
  const document = structuredClone(noraDocumentFixture);
  document.selection = { hidden: HIDDEN };
  document.selectedProfileId = HIDDEN;
  document.extensions = { mcpConfig: HIDDEN };
  document.nodes[0].markdown += `\n\n${VISIBLE}\n\n</script><script>globalThis.__breakout=true</script>`;
  document.nodes[0].extensions = { learn: { c8lb3: { attempts: 4, hidden: HIDDEN } } };
  document.sources[0].extensions = { localWorktreePath: `/tmp/${HIDDEN}` };
  document.evidence[0].extensions = { toolResult: HIDDEN };
  document.runs[0] = {
    ...document.runs[0],
    prompt: HIDDEN,
    profileId: HIDDEN,
    provider: HIDDEN,
    model: HIDDEN,
    endpoint: `https://example.test/${HIDDEN}`,
    error: { hidden: HIDDEN },
    extensions: {
      trace: [{ arguments: HIDDEN, result: HIDDEN }],
      mcp: { config: HIDDEN },
    },
  };
  return document;
}
