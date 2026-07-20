/**
 * Pure GenerationEvent accumulator and DocEvent builder.
 *
 * Browser branch/root/authoring and MCP generation hosts share this unit.
 * Hosts continue to own lifecycle, retries, aborts, timers, persistence, and
 * run-id minting.
 */

export class GenerationRun {
  /**
   * @param {{ id: string, initialMarkdown?: string, fallbackTitle?: string }} options
   */
  constructor({ id, initialMarkdown = "", fallbackTitle = "Untitled" }) {
    if (typeof id !== "string" || !id) throw new TypeError("GenerationRun id must be a non-empty string");
    if (typeof initialMarkdown !== "string") throw new TypeError("GenerationRun initialMarkdown must be a string");
    if (typeof fallbackTitle !== "string") throw new TypeError("GenerationRun fallbackTitle must be a string");
    this.id = id;
    this.seq = 0;
    this.markdown = initialMarkdown;
    this.title = fallbackTitle;
  }

  /**
   * Accumulate one GenerationEvent. Text events return a full-text
   * node_progress DocEvent; title events update completion state and return
   * null. Node metadata remains call-site context rather than run state.
   *
   * @param {import("./contracts/generation.js").GenerationEvent} event
   * @param {{ nodeId?: string, progressFields?: Record<string, unknown> }} [context]
   * @returns {import("./contracts/engine.js").NodeProgressEvent | null}
   */
  accept(event, context = {}) {
    if (!event || typeof event !== "object") throw new TypeError("GenerationRun event must be an object");
    if (event.type === "title") {
      if (typeof event.title !== "string") throw new TypeError("GenerationRun title must be a string");
      this.title = event.title;
      return null;
    }
    if (event.type !== "text") throw new TypeError("Unsupported GenerationEvent type");
    if (typeof event.delta !== "string") throw new TypeError("GenerationRun text delta must be a string");
    if (typeof context.nodeId !== "string" || !context.nodeId) {
      throw new TypeError("GenerationRun text acceptance requires a non-empty nodeId");
    }
    this.markdown += event.delta;
    this.seq += 1;
    return {
      type: "node_progress",
      ...(context.progressFields || {}),
      node_id: context.nodeId,
      markdown: this.markdown,
      run: { id: this.id, seq: this.seq },
    };
  }

  /**
   * Construct the final node_answered DocEvent from current accumulated state.
   * This method has no terminal effect: repeated calls are deterministic and
   * later accepted events remain visible to later completions.
   *
   * @param {{ nodeId: string, answeredFields?: Record<string, unknown> }} context
   * @returns {import("./contracts/engine.js").NodeAnsweredEvent}
   */
  complete({ nodeId, answeredFields = {} }) {
    if (typeof nodeId !== "string" || !nodeId) throw new TypeError("GenerationRun completion requires a non-empty nodeId");
    return {
      type: "node_answered",
      ...answeredFields,
      node_id: nodeId,
      title: this.title,
      markdown: this.markdown,
    };
  }

  /** @returns {{ id: string, seq: number, markdown: string, title: string }} */
  snapshot() {
    return { id: this.id, seq: this.seq, markdown: this.markdown, title: this.title };
  }
}
