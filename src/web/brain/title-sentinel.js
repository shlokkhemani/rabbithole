import { truncate } from "../../core/model.js";

export class TitleSentinelParser {
  constructor({ fallbackTitle = "Untitled" } = {}) {
    this.fallbackTitle = fallbackTitle || "Untitled";
    this.title = null;
    this.buffer = "";
    this.decided = false;
  }

  push(chunk) {
    const text = String(chunk ?? "");
    if (this.decided) return text;
    this.buffer += text;
    const newline = this.buffer.indexOf("\n");
    if (newline === -1 && this.buffer.length < 240) return "";

    const firstLine = newline === -1 ? this.buffer : this.buffer.slice(0, newline);
    const rest = newline === -1 ? "" : this.buffer.slice(newline + 1);
    const match = /^TITLE:\s*(.+?)\s*$/.exec(firstLine.trim());
    if (match) {
      this.title = truncate(match[1].trim(), 72) || this.fallbackTitle;
      this.decided = true;
      this.buffer = "";
      return rest.replace(/^\n+/, "");
    }
    this.title = this.fallbackTitle;
    this.decided = true;
    const out = this.buffer;
    this.buffer = "";
    return out;
  }

  finish() {
    if (this.decided) return "";
    const out = this.push("\n");
    return out;
  }
}

export function fallbackTitleForNode(node) {
  const origin = node?.origin || {};
  if (origin.synthesis) return "Synthesis";
  if (origin.lens) return origin.lens;
  return truncate(origin.question || node?.title || "Untitled", 72) || "Untitled";
}
