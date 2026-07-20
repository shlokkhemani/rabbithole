import { GenerationRun } from "../../core/generation-run.js";

/** Normalize MCP answer_branch chunks before shared generation accumulation. */
export class GenerationIngress {
  constructor({ id, nodeId, fallbackTitle = "Untitled" }) {
    this.nodeId = nodeId;
    this.run = new GenerationRun({ id, fallbackTitle });
  }

  /**
   * @param {unknown} content
   * @param {{ final?: boolean, title?: unknown, progressFields?: Record<string, unknown>, answeredFields?: Record<string, unknown> }} [options]
   */
  acceptChunk(content, { final = false, title, progressFields = {}, answeredFields = {} } = {}) {
    const raw = String(content ?? "");
    const buffered = this.run.snapshot().markdown;
    // Partials are deltas. The final MCP call may instead repeat the full text.
    const delta = final && buffered && raw.startsWith(buffered) ? raw.slice(buffered.length) : raw;
    const progress = this.run.accept({ type: "text", delta }, { nodeId: this.nodeId, progressFields });
    if (!final) return progress;

    const normalizedTitle = String(title ?? this.run.snapshot().title ?? "Untitled").trim() || "Untitled";
    this.run.accept({ type: "title", title: normalizedTitle });
    return this.run.complete({ nodeId: this.nodeId, answeredFields });
  }
}
