import { TitleSentinelParser } from "./title-sentinel.js";

/** Adapt raw provider text to the shared GenerationEvent vocabulary. */
export async function* adaptTextGeneration(chunks) {
  for await (const delta of chunks) {
    if (delta) yield { type: "text", delta };
  }
}

/** Branch-only adapter. Sentinel state is deliberately contained here. */
export async function* adaptBranchGeneration(chunks, { fallbackTitle = "Untitled" } = {}) {
  const parser = new TitleSentinelParser({ fallbackTitle });
  let titleEmitted = false;
  for await (const chunk of chunks) {
    const delta = parser.push(chunk);
    if (parser.decided && !titleEmitted) {
      titleEmitted = true;
      yield { type: "title", title: parser.title };
    }
    if (delta) yield { type: "text", delta };
  }
  const tail = parser.finish();
  if (!titleEmitted) yield { type: "title", title: parser.title };
  if (tail) yield { type: "text", delta: tail };
}
