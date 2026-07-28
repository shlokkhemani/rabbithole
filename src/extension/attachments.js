import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ASSET_BYTES_LIMIT, ARCHIVE_UNCOMPRESSED_BYTES_LIMIT, HEX_SHA256_RE } from "./archive/constants.js";
import { sha256Bytes } from "./archive/hash.js";
import { pdfSourceAssetName } from "../core/pdf-shared.js";

const IMAGE_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

/**
 * @typedef {{
 *   attachment: import("../core/contracts/document.js").NoraAttachment,
 *   source: import("../core/contracts/evidence.js").SourceRecord,
 *   evidence: import("../core/contracts/evidence.js").EvidenceRecord,
 *   assetName: string,
 *   sha256: string,
 *   bytes: number,
 *   mediaType: string
 * }} PreparedAttachment
 */

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {Array<{ sha256: string, bytes: number }>} candidates
 */
export function preflightAttachmentMetadata(document, candidates) {
  /** @type {Map<string, number>} */
  const known = new Map([...document.state.attachments.values()].map((attachment) => [attachment.sha256, attachment.bytes]));
  for (const candidate of candidates) {
    const sha256 = normalizeSha256(candidate.sha256);
    const bytes = safeByteLength(candidate.bytes, "asset bytes");
    if (bytes > ASSET_BYTES_LIMIT) throw new Error(`Asset exceeds ${ASSET_BYTES_LIMIT} bytes`);
    if (!known.has(sha256)) known.set(sha256, bytes);
  }
  const total = [...known.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total > ARCHIVE_UNCOMPRESSED_BYTES_LIMIT) {
    throw new Error(`Nora archive assets would exceed ${ARCHIVE_UNCOMPRESSED_BYTES_LIMIT} bytes`);
  }
  return { totalAssetBytes: total, uniqueAssetCount: known.size };
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {string} filePath
 * @param {{
 *   title?: string,
 *   mediaType?: string,
 *   parentNodeId?: string | null,
 *   now?: string,
 *   idFactory?: () => string
 * }} [options]
 */
export async function addFileAttachmentToDocument(document, filePath, options = {}) {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Attachment is not a file: ${absolute}`);
  if (stat.size > ASSET_BYTES_LIMIT) throw new Error(`Asset exceeds ${ASSET_BYTES_LIMIT} bytes`);
  const mediaType = options.mediaType ?? mediaTypeForFileName(absolute);
  const staged = await document.archiveWorkspace.stageAssetFile(absolute, { mediaType });
  preflightAttachmentMetadata(document, [staged]);
  const title = options.title || titleFromFileName(absolute);
  const prepared = prepareAttachmentRecord({
    document,
    sha256: staged.sha256,
    bytes: staged.bytes,
    mediaType,
    title,
    filename: path.basename(absolute),
    now: options.now,
    idFactory: options.idFactory,
    sourceType: "file",
    stableLocator: { kind: "file", filename: path.basename(absolute) },
  });
  await commitAttachmentRecords(document, prepared, { nodeId: options.parentNodeId ?? null });
  const node = await createAttachmentNode(document, prepared, {
    parentNodeId: options.parentNodeId ?? currentNodeId(document),
    now: options.now,
    idFactory: options.idFactory,
  });
  return { ...prepared, nodeId: node.nodeId };
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {Buffer | Uint8Array | string} bytes
 * @param {{
 *   title?: string,
 *   filename?: string | null,
 *   mediaType?: string,
 *   now?: string,
 *   idFactory?: () => string,
 *   sourceType?: string,
 *   stableLocator?: unknown,
 *   evidenceRange?: unknown,
 *   sourceId?: string | null,
 *   evidenceTitle?: string,
 *   evidenceExcerpt?: string,
 *   extensions?: Record<string, unknown>
 * }} [options]
 * @returns {Promise<PreparedAttachment>}
 */
export async function addBytesAttachmentToDocument(document, bytes, options = {}) {
  const buffer = Buffer.from(bytes);
  const sha256 = sha256Bytes(buffer);
  if (buffer.byteLength > ASSET_BYTES_LIMIT) throw new Error(`Asset exceeds ${ASSET_BYTES_LIMIT} bytes`);
  preflightAttachmentMetadata(document, [{ sha256, bytes: buffer.byteLength }]);
  const staged = await document.archiveWorkspace.stageAssetBytes(buffer, { mediaType: options.mediaType });
  const prepared = prepareAttachmentRecord({
    document,
    sha256: staged.sha256,
    bytes: staged.bytes,
    mediaType: options.mediaType ?? "application/octet-stream",
    title: options.title ?? options.filename ?? "Attachment",
    filename: options.filename ?? null,
    now: options.now,
    idFactory: options.idFactory,
    sourceType: options.sourceType ?? "attachment",
    stableLocator: options.stableLocator ?? { kind: "attachment", sha256: staged.sha256 },
    evidenceRange: options.evidenceRange,
    sourceId: options.sourceId,
    evidenceTitle: options.evidenceTitle,
    evidenceExcerpt: options.evidenceExcerpt,
    extensions: options.extensions,
  });
  await commitAttachmentRecords(document, prepared);
  return prepared;
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {Record<string, unknown>} crop
 */
export async function addWebviewCropAttachment(document, crop) {
  const encoded = requireString(crop.bytes_base64, "crop.bytes_base64");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded.replace(/\s+/g, "")) {
    throw new Error("crop.bytes_base64 must be valid base64 bytes");
  }
  const sha256 = sha256Bytes(bytes);
  const declared = crop.sha256 == null ? sha256 : normalizeSha256(crop.sha256);
  if (declared !== sha256) throw new Error("crop.sha256 does not match crop bytes");
  const assetName = assetNameFor({ sha256, mediaType: "image/png", filename: typeof crop.filename === "string" ? crop.filename : null });
  return addBytesAttachmentToDocument(document, bytes, {
    title: typeof crop.title === "string" && crop.title ? crop.title : "PDF crop",
    filename: assetName,
    mediaType: "image/png",
    sourceType: "pdf-region",
    stableLocator: {
      kind: "pdf-region",
      sourceSha256: crop.source_sha256 ?? null,
      page: crop.page ?? null,
      anchor: crop.anchor ?? null,
    },
    evidenceRange: crop.anchor ?? null,
    evidenceTitle: "PDF region crop",
    evidenceExcerpt: typeof crop.selected_text === "string" ? crop.selected_text : "",
    extensions: {
      assetName,
      kind: "pdf-crop",
      sourceSha256: crop.source_sha256 ?? null,
      page: crop.page ?? null,
      anchor: crop.anchor ?? null,
    },
  });
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {{ server: string, uri: string, content: Record<string, unknown> }} input
 */
export async function addMcpResourceBlobAttachment(document, input) {
  const blob = requireString(input.content.blob, "MCP resource blob");
  const bytes = Buffer.from(blob, "base64");
  if (!bytes.length || bytes.toString("base64") !== blob.replace(/\s+/g, "")) {
    throw new Error("MCP resource blob must be base64");
  }
  const mediaType = typeof input.content.mimeType === "string" && input.content.mimeType
    ? input.content.mimeType
    : "application/octet-stream";
  const title = `${input.server}: ${input.uri}`;
  return addBytesAttachmentToDocument(document, bytes, {
    title,
    filename: filenameFromResourceUri(input.uri, mediaType),
    mediaType,
    sourceType: "mcp-resource",
    stableLocator: { kind: "mcp-resource", server: input.server, uri: input.uri },
    evidenceTitle: title,
    evidenceExcerpt: `[binary ${mediaType}, ${bytes.byteLength} bytes]`,
    extensions: {
      assetName: assetNameFor({ sha256: sha256Bytes(bytes), mediaType, filename: filenameFromResourceUri(input.uri, mediaType) }),
      kind: "mcp-resource",
      server: input.server,
      uri: input.uri,
    },
  });
}

/**
 * @param {{
 *   document: import("./nora-document.js").NoraDocument,
 *   sha256: string,
 *   bytes: number,
 *   mediaType: string,
 *   title: string,
 *   filename?: string | null,
 *   now?: string,
 *   idFactory?: () => string,
 *   sourceType: string,
 *   stableLocator: unknown,
 *   evidenceRange?: unknown,
 *   sourceId?: string | null,
 *   evidenceTitle?: string,
 *   evidenceExcerpt?: string,
 *   extensions?: Record<string, unknown>
 * }} options
 * @returns {PreparedAttachment}
 */
export function prepareAttachmentRecord(options) {
  const sha256 = normalizeSha256(options.sha256);
  const bytes = safeByteLength(options.bytes, "asset bytes");
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? randomUUID;
  const sourceId = options.sourceId || `source:${idFactory()}`;
  const evidenceId = `evidence:${idFactory()}`;
  const assetName = assetNameFor({ sha256, mediaType: options.mediaType, filename: options.filename ?? null });
  const source = {
    id: sourceId,
    type: options.sourceType,
    stableLocator: options.stableLocator,
    title: options.title,
    capturedAt: now,
    extensions: {},
  };
  const evidence = {
    id: evidenceId,
    sourceId,
    sourceType: options.sourceType,
    stableLocator: options.stableLocator,
    title: options.evidenceTitle ?? options.title,
    excerpt: options.evidenceExcerpt ?? `${options.mediaType}, ${bytes} bytes`,
    capturedAt: now,
    range: options.evidenceRange ?? null,
    extensions: {},
  };
  const attachment = {
    id: `attachment:${sha256}`,
    sha256,
    mediaType: options.mediaType,
    title: options.title,
    filename: options.filename ?? null,
    bytes,
    sourceId,
    evidenceIds: [evidenceId],
    createdAt: now,
    extensions: {
      assetName,
      ...(options.extensions ?? {}),
    },
  };
  return { attachment, source, evidence, assetName, sha256, bytes, mediaType: options.mediaType };
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {PreparedAttachment} prepared
 * @param {{ nodeId?: string | null }} [options]
 */
export async function commitAttachmentRecords(document, prepared, options = {}) {
  const sourceExists = document.state.sources.has(prepared.source.id);
  const evidenceExists = document.state.evidence.has(prepared.evidence.id);
  const attachmentExists = document.state.attachments.has(prepared.attachment.id);
  if (!sourceExists) await document.commitEvent({ type: "source_record", source: prepared.source });
  if (!evidenceExists) await document.commitEvent({ type: "evidence_record", evidence: prepared.evidence });
  if (!attachmentExists) await document.commitEvent({ type: "attachment_record", attachment: prepared.attachment });
  if (options.nodeId) {
    await document.commitEvent({
      type: "node_references",
      node_id: options.nodeId,
      source_ids: [prepared.source.id],
      evidence_ids: [prepared.evidence.id],
      attachment_ids: [prepared.attachment.id],
      updated_at: prepared.attachment.createdAt,
    });
  }
}

/**
 * @param {import("./nora-document.js").NoraDocument} document
 * @param {PreparedAttachment} prepared
 * @param {{ parentNodeId?: string | null, now?: string, idFactory?: () => string }} [options]
 */
async function createAttachmentNode(document, prepared, options = {}) {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? new Date().toISOString();
  const parentNodeId = options.parentNodeId && document.state.nodes.has(options.parentNodeId)
    ? options.parentNodeId
    : document.state.rootNodeId;
  const nodeId = `attachment-node:${idFactory()}`;
  const parent = document.state.nodes.get(parentNodeId);
  const y = Number(parent?.position?.y ?? 0) + 260;
  const x = Number(parent?.position?.x ?? 0) + 360;
  await document.commitEvent({
    type: "branch_request",
    request_id: nodeId,
    node_id: nodeId,
    parent_id: parentNodeId,
    question: prepared.attachment.title,
    branch_type: "followup",
    position: { x, y },
    size: { w: 320, h: 220 },
    created_at: now,
  });
  await document.commitEvent({
    type: "node_answered",
    node_id: nodeId,
    parent_id: parentNodeId,
    title: prepared.attachment.title,
    markdown: markdownForAttachment(prepared),
    read: true,
    created_at: now,
  });
  if (prepared.mediaType === "application/pdf") {
    await document.commitEvent({
      type: "node_extensions_patch",
      node_id: nodeId,
      namespace: "pdf",
      value: pendingPdfExtension(prepared),
    });
  }
  await commitAttachmentRecords(document, prepared, { nodeId });
  return { nodeId };
}

/** @param {PreparedAttachment} prepared */
function markdownForAttachment(prepared) {
  if (prepared.mediaType === "application/pdf") return `# ${prepared.attachment.title}\n\nPDF source attached.\n`;
  if (prepared.mediaType.startsWith("image/")) return `# ${prepared.attachment.title}\n\n![${prepared.attachment.title}](asset:${prepared.assetName})\n`;
  return `# ${prepared.attachment.title}\n\nAttached ${prepared.mediaType} (${prepared.bytes} bytes).\n`;
}

/** @param {PreparedAttachment} prepared */
function pendingPdfExtension(prepared) {
  return {
    version: 2,
    source: { asset: prepared.assetName, sha256: prepared.sha256, byte_length: prepared.bytes },
    page_count: 0,
    pages: [],
    lines: [],
    notes: ["PDF metadata will be prepared in the Nora webview."],
    converting: false,
    converted: false,
    original_markdown: null,
    needs_webview_prepare: true,
  };
}

/**
 * @param {{ sha256: string, mediaType: string, filename?: string | null }} input
 */
export function assetNameFor(input) {
  const sha256 = normalizeSha256(input.sha256);
  if (input.mediaType === "application/pdf") return pdfSourceAssetName(sha256);
  const ext = extensionForMediaType(input.mediaType) ?? extensionFromFileName(input.filename) ?? "bin";
  const prefix = input.mediaType.startsWith("image/") ? "image" : "asset";
  return `${prefix}-${sha256}.${ext}`;
}

/** @param {string} filePath */
export function mediaTypeForFileName(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  return IMAGE_EXTENSIONS.get(ext) ?? "application/octet-stream";
}

/** @param {string} filePath */
function titleFromFileName(filePath) {
  return path.basename(filePath).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Attachment";
}

/** @param {string} uri @param {string} mediaType */
function filenameFromResourceUri(uri, mediaType) {
  const raw = String(uri || "").split(/[/?#]/).filter(Boolean).pop() || "resource";
  const clean = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "resource";
  if (path.extname(clean)) return clean;
  const ext = extensionForMediaType(mediaType);
  return ext ? `${clean}.${ext}` : clean;
}

/** @param {string | null | undefined} filename */
function extensionFromFileName(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]+$/.test(ext) ? ext : null;
}

/** @param {string} mediaType */
function extensionForMediaType(mediaType) {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/svg+xml") return "svg";
  return null;
}

/** @param {unknown} value */
function normalizeSha256(value) {
  const sha256 = String(value ?? "").toLowerCase();
  if (!HEX_SHA256_RE.test(sha256)) throw new Error("Attachment needs a lowercase SHA-256 digest");
  return sha256;
}

/** @param {unknown} value @param {string} label */
function safeByteLength(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

/** @param {import("./nora-document.js").NoraDocument} document */
function currentNodeId(document) {
  const view = document.state.viewState;
  const nodeId = view && typeof view === "object" ? String(/** @type {{ node_id?: unknown }} */ (view).node_id ?? "") : "";
  return nodeId && document.state.nodes.has(nodeId) ? nodeId : document.state.rootNodeId;
}

/**
 * Utility used by tests to hash large sparse files without buffering them.
 * @param {string} filePath
 */
export async function hashAttachmentFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}
