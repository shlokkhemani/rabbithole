import { createHash } from "node:crypto";
import { collectAllNotes } from "../../core/hole/ask.js";

/** @param {unknown} content */
export function noteContentHash(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex").slice(0, 16);
}

/** @param {Map<string, any> | Record<string, any>} nodes */
export function noteHashesForNodes(nodes) {
  return new Map(collectAllNotes(nodes).map((entry) => [entry.note_id, noteContentHash(entry.content)]));
}

/** @param {Map<string, string>} deliveredNoteHashes @param {Array<Record<string, any>>} entries */
export function recordDeliveredNoteEntries(deliveredNoteHashes, entries) {
  for (const entry of entries) {
    if (!entry || typeof entry.note_id !== "string") continue;
    deliveredNoteHashes.set(entry.note_id, noteContentHash(entry.content));
  }
}

/** @param {Array<{notes?: Array<Record<string, any>>}>} entries */
export function notesFromContextEntries(entries) {
  return entries.flatMap((entry) => Array.isArray(entry.notes) ? entry.notes : []);
}
