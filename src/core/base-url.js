import { resolveAssetMarkdownImageUrl } from "./assets.js";

const BASE_URL_KEYS = ["base_url", "canonical", "canonical_url", "source_url", "url", "source"];
const VALID_BASE_SOURCES = new Set(["explicit", "frontmatter", "inherited"]);
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** @typedef {{ base_url: string | null, base_url_source: import("./contracts/artifact.js").BaseUrlSource | null }} BaseFields */
/** @typedef {Record<string, any>} LooseObject */

/** @param {unknown} value @param {string} [paramName] */
export function normalizeBaseUrl(value, paramName = "base_url") {
  if (value == null) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${paramName} must be an absolute http: or https: URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${paramName} must be an absolute http: or https: URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${paramName} must not include credentials`);
  }
  return url.href;
}

/** @param {unknown} value */
function parseHttpBaseUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function unquoteYamlValue(value) {
  const trimmed = String(value ?? "").trim();
  let unquoted = trimmed;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") unquoted = parsed;
      else unquoted = trimmed.slice(1, -1);
    } catch {
      unquoted = trimmed.slice(1, -1);
    }
  } else if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    unquoted = trimmed.slice(1, -1).replace(/''/g, "'");
  }
  const compact = String(unquoted).trim();
  if (compact.length >= 2 && compact.startsWith("<") && compact.endsWith(">")) return compact.slice(1, -1).trim();
  return compact;
}

/** @param {unknown} markdown */
export function inferBaseUrlFromFrontmatter(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  if (lines[0]?.charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return null;

  /** @type {Record<string, string>} */
  const entries = {};
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^---[ \t]*$/.test(line)) {
      closed = true;
      break;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(entries, key)) entries[key] = unquoteYamlValue(match[2]);
  }
  if (!closed) return null;

  for (const key of BASE_URL_KEYS) {
    const baseUrl = parseHttpBaseUrl(entries[key]);
    if (baseUrl) return baseUrl;
  }
  return null;
}

/** @param {{ markdown?: unknown, explicitBaseUrl?: unknown, inheritedBaseUrl?: unknown }} [options] @returns {BaseFields} */
export function deriveNodeBaseUrl({ markdown, explicitBaseUrl = null, inheritedBaseUrl = null } = {}) {
  const explicit = normalizeBaseUrl(explicitBaseUrl);
  if (explicit) return { base_url: explicit, base_url_source: "explicit" };

  const frontmatter = inferBaseUrlFromFrontmatter(markdown);
  if (frontmatter) return { base_url: frontmatter, base_url_source: "frontmatter" };

  const inherited = parseHttpBaseUrl(inheritedBaseUrl);
  if (inherited) return { base_url: inherited, base_url_source: "inherited" };

  return { base_url: null, base_url_source: null };
}

/** @param {LooseObject | null | undefined} parent @returns {BaseFields} */
export function inheritedNodeBaseUrl(parent) {
  const inherited = parseHttpBaseUrl(parent?.base_url);
  return inherited
    ? { base_url: inherited, base_url_source: "inherited" }
    : { base_url: null, base_url_source: null };
}

/** @param {LooseObject | null | undefined} node @returns {BaseFields} */
export function normalizeStoredBaseUrlFields(node) {
  const source = VALID_BASE_SOURCES.has(node?.base_url_source) ? /** @type {import("./contracts/artifact.js").BaseUrlSource} */ (node?.base_url_source) : null;
  const baseUrl = parseHttpBaseUrl(node?.base_url);
  return {
    base_url: source && baseUrl ? baseUrl : null,
    base_url_source: source && baseUrl ? source : null,
  };
}

/** @param {LooseObject | null | undefined} node */
export function maybeUpgradeBaseUrlFromFrontmatter(node) {
  if (!node || (node.base_url_source !== "inherited" && node.base_url_source !== null)) return false;
  const frontmatter = inferBaseUrlFromFrontmatter(node.markdown ?? "");
  if (!frontmatter) return false;
  node.base_url = frontmatter;
  node.base_url_source = "frontmatter";
  return true;
}

/** @param {LooseObject | null | undefined} hole */
export function backfillLegacyHoleBaseUrls(hole) {
  if (!Array.isArray(hole?.nodes)) return false;
  /** @type {Map<string, LooseObject>} */
  const byId = new Map();
  for (const node of hole.nodes) {
    if (node && typeof node === "object" && node.id != null) byId.set(String(node.id), node);
  }

  let changed = false;
  /** @type {Map<LooseObject, BaseFields>} */
  const resolved = new Map();
  /** @type {Set<LooseObject>} */
  const resolving = new Set();

  /** @param {LooseObject} node @param {BaseFields} base */
  function apply(node, base) {
    const nodeChanged = node.base_url !== base.base_url || node.base_url_source !== base.base_url_source;
    node.base_url = base.base_url;
    node.base_url_source = base.base_url_source;
    changed = changed || nodeChanged;
    return base;
  }

  /** @param {LooseObject | null | undefined} node @returns {BaseFields} */
  function resolve(node) {
    if (!node || typeof node !== "object") return { base_url: null, base_url_source: null };
    if (resolved.has(node)) return /** @type {BaseFields} */ (resolved.get(node));
    if (resolving.has(node)) return { base_url: null, base_url_source: null };
    resolving.add(node);

    const hasStoredFields =
      Object.prototype.hasOwnProperty.call(node, "base_url") &&
      Object.prototype.hasOwnProperty.call(node, "base_url_source");
    /** @type {BaseFields} */
    let base;
    if (hasStoredFields) {
      base = normalizeStoredBaseUrlFields(node);
    } else {
      const frontmatter = inferBaseUrlFromFrontmatter(node.markdown ?? "");
      if (frontmatter) {
        base = { base_url: frontmatter, base_url_source: "frontmatter" };
      } else {
        const parent = node.parent_id == null ? null : byId.get(String(node.parent_id));
        const inherited = resolve(parent).base_url;
        base = inherited
          ? { base_url: inherited, base_url_source: "inherited" }
          : { base_url: null, base_url_source: null };
      }
    }

    resolving.delete(node);
    resolved.set(node, base);
    return apply(node, base);
  }

  for (const node of hole.nodes) resolve(node);
  return changed;
}

/** @param {unknown} raw @param {string | null} baseUrl @returns {baseUrl is string} */
function shouldResolveUrl(raw, baseUrl) {
  if (!baseUrl) return false;
  const value = String(raw ?? "");
  if (value.startsWith("#")) return false;
  return !SCHEME_URL.test(value);
}

/** @param {string} value */
function rewriteGithubImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return value;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5) return value;
  const [owner, repo, mode, ref, ...pathParts] = parts;
  if ((mode !== "blob" && mode !== "raw") || !owner || !repo || !ref || pathParts.length === 0) return value;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${pathParts.join("/")}`;
}

/** @param {unknown} raw @param {{ baseUrl?: string | null, image?: boolean, assetNames?: Set<string> | null, resolveAssetUrl?: ((name: string) => string | null) }} [options] */
export function resolveMarkdownUrl(raw, { baseUrl = null, image = false, assetNames = null, resolveAssetUrl = undefined } = {}) {
  let value = String(raw ?? "");
  if (image) {
    const assetUrl = resolveAssetMarkdownImageUrl(value, { assetNames, resolveAssetUrl });
    if (assetUrl !== undefined) return assetUrl;
  }
  if (shouldResolveUrl(value, baseUrl)) {
    try {
      value = new URL(value, baseUrl).href;
    } catch {
      // Keep the raw value and let the existing sanitizer make the final call.
    }
  }
  return image ? rewriteGithubImageUrl(value) : value;
}
