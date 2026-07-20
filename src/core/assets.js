const IMAGE_ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const ALLOWED_ASSET_EXTENSIONS = [...IMAGE_ASSET_EXTENSIONS, "pdf"];
export const MAX_ASSETS_PER_CALL = 50;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_SOURCE_BYTES = 100 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set(ALLOWED_ASSET_EXTENSIONS);
const IMAGE_EXTENSIONS = new Set(IMAGE_ASSET_EXTENSIONS);
const ASSET_NAME_RE = /^([a-z0-9][a-z0-9_-]*)\.([a-z0-9]+)$/;
const ASSET_URL_RE = /^asset:(.*)$/i;
const ASSET_REF_RE = /\basset:([a-z0-9][a-z0-9_-]*\.[a-z0-9]+)/gi;

/** @param {unknown} name */
function getAssetExtension(name) {
  const match = ASSET_NAME_RE.exec(String(name ?? ""));
  if (!match) return null;
  const ext = match[2];
  return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

/** @param {unknown} name */
function isValidAssetName(name) {
  return getAssetExtension(name) !== null;
}

/** @param {unknown} name */
function isValidImageAssetName(name) {
  const ext = getAssetExtension(name);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

/**
 * @param {unknown} name
 * @param {string} [paramName]
 */
export function validateAssetName(name, paramName = "asset name") {
  const value = String(name ?? "");
  if (!isValidAssetName(value)) {
    throw new Error(
      `${paramName} must be a lowercase filename with one extension from ` +
        ALLOWED_ASSET_EXTENSIONS.join(", ") +
        `; got ${JSON.stringify(name)}`
    );
  }
  return value;
}

/** @param {unknown} name */
export function getAssetContentType(name) {
  const ext = getAssetExtension(name);
  if (!ext) validateAssetName(name);
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      throw new Error(`Unsupported asset extension: ${ext}`);
  }
}

/** @param {string} name */
export function defaultAssetUrlResolver(name) {
  const slash = String.fromCharCode(47);
  return slash + "assets" + slash + name;
}

/**
 * @param {unknown} raw
 * @param {{assetNames?: Set<string> | null, resolveAssetUrl?: (name: string) => string | null}} [options]
 */
export function resolveAssetMarkdownImageUrl(raw, { assetNames = null, resolveAssetUrl = defaultAssetUrlResolver } = {}) {
  const match = ASSET_URL_RE.exec(String(raw ?? ""));
  if (!match) return undefined;

  const name = match[1];
  // PDF sources share the binary blob store, but they are documents rather
  // than Markdown images. Keeping that distinction here prevents a source PDF
  // from accidentally becoming a broken <img> if its asset name is mentioned.
  if (!isValidImageAssetName(name)) return null;
  if (assetNames && !assetNames.has(name)) return null;
  return resolveAssetUrl(name);
}

/** @param {unknown} markdown */
export function extractAssetRefsFromMarkdown(markdown) {
  const refs = new Set();
  for (const match of String(markdown ?? "").matchAll(ASSET_REF_RE)) {
    const name = match[1].toLowerCase();
    if (isValidImageAssetName(name)) refs.add(name);
  }
  return refs;
}

/** Single asset-reference view used by deletion candidates, survivors, and undo. */
/** @param {any} node */
export function extractNodeAssetRefs(node) {
  const refs = new Set(extractAssetRefsFromMarkdown(node?.markdown));
  try { refs.add(validateAssetName(node?.origin?.crop_asset)); } catch {}
  const pages = node?.extensions?.pdf?.pages;
  if (Array.isArray(pages)) {
    for (const page of pages) {
      try { refs.add(validateAssetName(page?.asset)); } catch {}
    }
  }
  try { refs.add(validateAssetName(node?.extensions?.pdf?.source?.asset)); } catch {}
  return refs;
}

/** The source PDF is allowed to be larger than a visual Markdown asset. */
/** @param {unknown} name */
export function maxAssetBytes(name) {
  return getAssetExtension(name) === "pdf" ? MAX_PDF_SOURCE_BYTES : MAX_ASSET_BYTES;
}

/** Deterministic durable name for a region crop owned by a branch node. */
/** @param {unknown} nodeId */
export function cropAssetNameForNode(nodeId) {
  const safe = String(nodeId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "selection";
  return `crop-${safe}.jpg`;
}
