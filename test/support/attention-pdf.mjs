import fs from "node:fs/promises";
import path from "node:path";

export const ATTENTION_PDF_PATH = path.resolve(
  new URL("../fixtures/pdfs/attention-is-all-you-need.pdf", import.meta.url).pathname,
);
export const ATTENTION_PDF_TWO_PAGE_PATH = path.resolve(
  new URL("../fixtures/pdfs/attention-is-all-you-need-pages-1-2.pdf", import.meta.url).pathname,
);
export const ATTENTION_PDF_SHA256 = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
export const ATTENTION_PDF_PAGE_COUNT = 15;
export const ATTENTION_PAGE_VIEW = [0, 0, 612, 792];

export function readAttentionPdf() {
  return fs.readFile(ATTENTION_PDF_PATH);
}

export function readAttentionPdfTwoPage() {
  return fs.readFile(ATTENTION_PDF_TWO_PAGE_PATH);
}
