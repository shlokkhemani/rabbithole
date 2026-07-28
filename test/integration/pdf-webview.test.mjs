import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { baseHydration, bootNoraWebview } from "../support/webview-harness.mjs";
import {
  ATTENTION_PAGE_VIEW,
  ATTENTION_PDF_PATH,
  ATTENTION_PDF_SHA256,
} from "../support/attention-pdf.mjs";

const app = await bootNoraWebview();
const { page } = app;

try {
  const origin = await page.evaluate(() => location.origin);
  const sourceAsset = `pdf-${ATTENTION_PDF_SHA256}.pdf`;
  const source = {
    asset: sourceAsset,
    sha256: ATTENTION_PDF_SHA256,
    byte_length: (await fs.stat(ATTENTION_PDF_PATH)).size,
  };
  const pdfNode = {
    ...baseHydration().nodes[0],
    title: "Attention PDF",
    markdown: "# Attention PDF\n",
    extensions: {
      pdf: {
        version: 2,
        source,
        page_count: 15,
        pages: [{ n: 1, view: ATTENTION_PAGE_VIEW, rotate: 0, user_unit: 1 }],
        lines: [],
        notes: [],
        converting: false,
        converted: false,
        original_markdown: null,
      },
    },
  };
  await app.hydrate(baseHydration({
    nodes: [pdfNode],
    asset_data: {
      [sourceAsset]: `${origin}/test/fixtures/pdfs/attention-is-all-you-need.pdf`,
    },
  }));

  await page.locator(".rh-pdf-page").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".rh-pdf-textlayer")?.textContent?.includes("Attention"));

  const preparedCrop = await page.evaluate(async () => window.__noraTest.prepareOutgoingEvent({
    type: "branch_request",
    request_id: "crop-request",
    node_id: "crop-child",
    parent_id: "root",
    question: "What is in this region?",
    selected_text: "Attention",
    anchor: {
      offset_start: 0,
      offset_end: 0,
      pdf: {
        version: 2,
        source_sha256: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
        kind: "region",
        fragments: [{ page: 1, quads: [[[72, 720], [180, 720], [180, 680], [72, 680]]] }],
      },
    },
  }));
  assert.equal(preparedCrop.event.crop.media_type, "image/png");
  assert.match(preparedCrop.event.crop.bytes_base64, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(preparedCrop.event.crop.source_sha256, ATTENTION_PDF_SHA256);
  assert.equal(preparedCrop.event.crop.page, 1);
  assert.equal(preparedCrop.cropAsset, `image-${preparedCrop.event.crop.sha256}.png`);

  const conversion = await page.evaluate(async () => window.__noraTest.prepareOutgoingEvent({
    type: "convert_pdf",
    node_id: "root",
  }));
  assert.equal(conversion.event.conversion.pdfExtension.source.sha256, ATTENTION_PDF_SHA256);
  assert(conversion.event.conversion.markdown.includes("Attention Is All You Need"));
  assert(conversion.event.conversion.pdfExtension.lines.length > 0);
  assert.equal(await page.evaluate(() => Boolean(globalThis.process?.versions?.node)), false, "webview PDF path must not use a Node/native canvas runtime");

  console.log("Nora PDF webview rendering, text extraction, crop, and conversion verification passed");
} finally {
  await app.close();
}
