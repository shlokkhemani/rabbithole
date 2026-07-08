export const ALLOWED_ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
export const MAX_ASSETS_PER_CALL = 50;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set(ALLOWED_ASSET_EXTENSIONS);
const ASSET_NAME_RE = /^([a-z0-9][a-z0-9_-]*)\.([a-z0-9]+)$/;
const ASSET_URL_RE = /^asset:(.*)$/i;

export function getAssetExtension(name) {
  const match = ASSET_NAME_RE.exec(String(name ?? ""));
  if (!match) return null;
  const ext = match[2];
  return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

export function isValidAssetName(name) {
  return getAssetExtension(name) !== null;
}

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
    default:
      throw new Error(`Unsupported asset extension: ${ext}`);
  }
}

export function resolveAssetMarkdownImageUrl(raw, { assetNames = null } = {}) {
  const match = ASSET_URL_RE.exec(String(raw ?? ""));
  if (!match) return undefined;

  const name = match[1];
  if (!isValidAssetName(name)) return null;
  if (assetNames && !assetNames.has(name)) return null;
  return `/assets/${name}`;
}
