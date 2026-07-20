export const TRANSCRIBE_V1_RULES = `Transcribe the supplied PDF page images in reading order into faithful GitHub-flavored Markdown.
Preserve headings, paragraphs, lists, emphasis, links, footnotes, and code. Use LaTeX for mathematics and GFM tables for tabular material. Merge words hyphenated only by a line or page break. Drop repeated running headers, footers, and page numbers.
Represent each meaningful figure as ![caption](figure:page-NNN:x,y,w,h), where NNN is the zero-padded source page and x,y,w,h are normalized decimal coordinates in [0,1]. Do not invent or crop figures. Return only the transcription: no TITLE sentinel, commentary, or code fence around the document.`;

/** @param {{pages?: Array<{n:number, data_url:string}>, tail?: string}} [input] */
export function buildTranscribeMessages({ pages = [], tail = "" } = {}) {
  const continuity = String(tail || "").slice(-500);
  /** @type {Array<any>} */
  const content = [{ type: "text", text: `${TRANSCRIBE_V1_RULES}\n\n${continuity ? `The already committed document ends with:\n<tail>\n${continuity}\n</tail>\nContinue without repeating it.` : "Begin the document."}` }];
  for (const page of pages) {
    content.push({ type: "text", text: `Source page ${Number(page.n)}` });
    content.push({ type: "image_url", image_url: { url: String(page.data_url || "") } });
  }
  return [{ role: "user", content }];
}
