/** @typedef {"sanitize-html" | "inert"} BlockSecurity */
/** @typedef {{ type: string, version: number, parse: (source: string) => unknown, toPlainText: (model: any) => string, security: BlockSecurity }} BlockTypeDescriptor */

/** @type {Map<string, BlockTypeDescriptor>} */
const blockTypes = new Map();

/** @param {unknown} value */
function normalizedType(value) {
  return String(value || "").toLowerCase();
}

/** @param {BlockTypeDescriptor} descriptor */
export function registerBlockType(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new TypeError("Block type descriptor must be an object");
  const type = normalizedType(descriptor.type);
  if (!type || !/^[a-z][a-z0-9_-]*$/.test(type)) throw new TypeError("Block type descriptor.type must be a fence-safe name");
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) throw new TypeError(`Block type "${type}" must have a positive integer version`);
  if (typeof descriptor.parse !== "function") throw new TypeError(`Block type "${type}" must provide parse(source)`);
  if (typeof descriptor.toPlainText !== "function") throw new TypeError(`Block type "${type}" must provide toPlainText(model)`);
  if (descriptor.security !== "sanitize-html" && descriptor.security !== "inert") {
    throw new TypeError(`Block type "${type}" security must be "sanitize-html" or "inert"`);
  }
  if (blockTypes.has(type)) throw new Error(`Block type "${type}" is already registered`);
  const registered = Object.freeze({ ...descriptor, type });
  blockTypes.set(type, registered);
  return registered;
}

/** @param {unknown} type */
export function getBlockType(type) {
  return blockTypes.get(normalizedType(type));
}

export function listBlockTypes() {
  return [...blockTypes.values()];
}

export const BLOCK_ID_PATTERN = /^[a-z0-9]{4,8}$/;

/** @param {unknown} info */
export function parseBlockInfo(info) {
  const parts = String(info || "").trim().split(/\s+/).filter(Boolean);
  const type = normalizedType(parts[0]);
  let id = null;
  for (let i = 1; i < parts.length; i += 1) {
    const match = /^id=([^\s]+)$/i.exec(parts[i]);
    if (match && BLOCK_ID_PATTERN.test(match[1])) id = match[1];
  }
  return { type, id };
}

function defaultBlockIdFactory() {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

/**
 * Add durable ids to registered fenced blocks and canonicalize registered
 * opener info strings. Every byte outside an affected opener is preserved.
 *
 * @param {string} markdown
 * @param {{ idFactory?: () => string }} [options]
 */
export function normalizeBlockIds(markdown, { idFactory = defaultBlockIdFactory } = {}) {
  const source = String(markdown ?? "");
  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  let active = null;
  let changed = false;
  const output = [];
  for (const wholeLine of lines) {
    if (!wholeLine) continue;
    const ending = wholeLine.endsWith("\r\n") ? "\r\n" : wholeLine.endsWith("\n") ? "\n" : wholeLine.endsWith("\r") ? "\r" : "";
    const line = ending ? wholeLine.slice(0, -ending.length) : wholeLine;
    if (active) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[2][0] === active.char && close[2].length >= active.width) active = null;
      output.push(wholeLine);
      continue;
    }
    const open = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!open) {
      output.push(wholeLine);
      continue;
    }
    const marker = open[2];
    const info = open[3].trim();
    active = { char: marker[0], width: marker.length };
    const parsed = parseBlockInfo(info);
    if (!getBlockType(parsed.type)) {
      output.push(wholeLine);
      continue;
    }
    let id = parsed.id;
    if (!id) {
      id = String(idFactory());
      if (!BLOCK_ID_PATTERN.test(id)) throw new Error(`Block id factory returned invalid id ${JSON.stringify(id)}`);
    }
    const normalized = `${open[1]}${marker}${parsed.type} id=${id}${ending}`;
    changed ||= normalized !== wholeLine;
    output.push(normalized);
  }
  return { markdown: output.join(""), changed };
}

registerBlockType({
  type: "show",
  version: 1,
  parse(source) { return String(source ?? ""); },
  toPlainText() { return ""; },
  security: "sanitize-html",
});

/** @param {string} source */
function parseCheck(source) {
  let model;
  try {
    model = JSON.parse(String(source ?? ""));
  } catch (error) {
    throw new Error(`Check body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("Check body must be a JSON object");
  if (typeof model.question !== "string" || !model.question.trim()) throw new Error("Check question must be a non-empty string");
  if (!Array.isArray(model.options)) throw new Error("Check options must be an array of 2-6 strings");
  if (model.options.length < 2 || model.options.length > 6) throw new Error("Check options must contain 2-6 strings");
  if (model.options.some((/** @type {unknown} */ option) => typeof option !== "string")) throw new Error("Check options must contain only strings");
  if (!Number.isInteger(model.answer)) throw new Error("Check answer must be an integer option index");
  if (model.answer < 0 || model.answer >= model.options.length) throw new Error("Check answer must index an existing option");
  if (model.explanation !== undefined && typeof model.explanation !== "string") throw new Error("Check explanation must be a string when provided");
  return {
    question: model.question,
    options: [...model.options],
    answer: model.answer,
    ...(model.explanation !== undefined ? { explanation: model.explanation } : {}),
  };
}

registerBlockType({
  type: "check",
  version: 1,
  parse: parseCheck,
  toPlainText(model) { return [model.question, ...model.options].join("\n"); },
  security: "sanitize-html",
});
