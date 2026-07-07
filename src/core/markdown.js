import { Marked } from "marked";
import { escapeHtml } from "./utils.js";

const MARKED_OPTIONS = { gfm: true, breaks: false };

// The rendered HTML is injected into the page via innerHTML, so markdown must not
// be able to smuggle executable HTML. marked (per the CommonMark spec) passes raw
// HTML through verbatim and does not strip dangerous URL schemes, so we override
// the renderer to (a) escape any raw HTML to inert text and (b) allowlist URL
// schemes on links/images. This is the single chokepoint all node markdown flows
// through (root docs, answers, resumes).
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
const SAFE_IMG = /^(?:https?:\/\/|\/|\.\/|\.\.\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;
// Whitespace/control chars used to obfuscate a scheme (e.g. "java\tscript:").
const URL_NOISE = new RegExp("[\\u0000-\\u0020]+", "g");
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BASE_URL_KEYS = new Set(["canonical", "url", "source", "source_url", "base_url"]);

function sanitizeUrl(href, allow) {
  if (!href) return null;
  // Validate the scheme against a stripped probe (so "java\tscript:" can't sneak
  // past), but return the ORIGINAL url when it passes — stripping the real url
  // would corrupt legitimate values like "https://example.com/a b".
  const probe = String(href).replace(URL_NOISE, "");
  return allow.test(probe) ? String(href) : null;
}

function cleanFrontmatterValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function findBaseUrlInLines(lines) {
  for (const wantedKey of BASE_URL_KEYS) {
    for (const line of lines) {
      const parsed = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
      if (!parsed || parsed[1].toLowerCase() !== wantedKey) continue;

      const value = cleanFrontmatterValue(parsed[2]);
      if (isHttpUrl(value)) return value;
    }
  }

  return null;
}

function inferMarkdownBaseUrl(markdown) {
  const source = String(markdown ?? "");
  const match = FRONTMATTER.exec(source);
  const frontmatterBase = match ? findBaseUrlInLines(match[1].split(/\r?\n/)) : null;
  if (frontmatterBase) return frontmatterBase;

  // Agent/reader output can prepend a small provenance header before extracted
  // frontmatter. Scan only the document prologue so normal article content cannot
  // unexpectedly change URL resolution halfway through a document.
  return findBaseUrlInLines(source.split(/\r?\n/, 80).slice(0, 80));
}

function resolveAgainstBase(href, baseUrl) {
  const raw = String(href ?? "");
  if (!baseUrl || raw.startsWith("#")) return raw;

  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

function createRenderer(baseUrl) {
  return {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = sanitizeUrl(resolveAgainstBase(href, baseUrl), SAFE_URL);
      if (safe === null) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      // Open real links in a new tab so clicking one never navigates away from (and
      // thereby tears down) the Rabbithole page; keep in-page fragment links local.
      const target = safe.startsWith("#") ? "" : ` target="_blank"`;
      return `<a href="${escapeHtml(safe)}"${titleAttr}${target} rel="noopener noreferrer">${text}</a>`;
    },
    image({ href, title, text }) {
      const safe = sanitizeUrl(resolveAgainstBase(href, baseUrl), SAFE_IMG);
      if (safe === null) return escapeHtml(text || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
    },
  };
}

export function resolveMarkdownBaseUrl(markdown, baseUrl) {
  return isHttpUrl(baseUrl) ? baseUrl : inferMarkdownBaseUrl(markdown);
}

/** Renders markdown to safe HTML, collapsing inter-tag whitespace for compact embedding. */
export async function renderMarkdownToHtml(markdown, { baseUrl } = {}) {
  const source = String(markdown ?? "");
  const parser = new Marked(MARKED_OPTIONS);
  parser.use({ renderer: createRenderer(resolveMarkdownBaseUrl(source, baseUrl)) });
  const html = await parser.parse(source);
  return html.replace(/>\n+</g, "><").replace(/\n<\/code>/g, "</code>");
}
