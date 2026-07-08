import { Buffer } from "node:buffer";
import { marked } from "marked";
import katex from "katex";
import hljs from "highlight.js";
import { escapeHtml } from "./utils.js";
import { resolveMarkdownUrl } from "./base-url.js";

marked.setOptions({ gfm: true, breaks: false });

const fenceRenderers = new Map();

export function registerFenceRenderer(language, render) {
  fenceRenderers.set(String(language || "").toLowerCase(), render);
}

// The rendered HTML is injected into the page via innerHTML, so markdown must not
// be able to smuggle executable HTML. marked (per the CommonMark spec) passes raw
// HTML through verbatim and does not strip dangerous URL schemes, so we override
// the renderer to (a) escape any raw HTML to inert text and (b) allowlist URL
// schemes on links/images. This is the single chokepoint all node markdown flows
// through (root docs, answers, resumes).
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
const SAFE_IMG = /^(?:https?:\/\/|\/|\.\/|\.\.\/|asset:[a-z0-9][a-z0-9_-]*\.(?:png|jpe?g|gif|webp|svg)$|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;
// Whitespace/control chars used to obfuscate a scheme (e.g. "java\tscript:").
const URL_NOISE = new RegExp("[\\u0000-\\u0020]+", "g");
const INLINE_DOLLAR = "$";
const DISPLAY_DOLLARS = "$$";
const BACKSLASH_OPEN_INLINE = "\\(";
const BACKSLASH_CLOSE_INLINE = "\\)";
const BACKSLASH_OPEN_DISPLAY = "\\[";
const BACKSLASH_CLOSE_DISPLAY = "\\]";
const TRAILING_NEWLINE = /\n$/;
const BLOCK_MATH_START = /(?:^|\n) {0,3}(?:\$\$(?!\$)|\\\[)/;
const VISUAL_FENCE_LANGUAGES = new Set(["show"]);
const VISUAL_FENCE_START = /(?:^|\n) {0,3}`{3,}[ \t]*show(?=$|[ \t\n])/i;
let renderBaseUrl = null;
let renderAssetNames = null;

function isWhitespace(ch) {
  return ch === undefined || /\s/.test(ch);
}

function isDigit(ch) {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isEscapedAt(src, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && src[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function findBacktickRunEnd(src, index) {
  let width = 1;
  while (src[index + width] === "`") width += 1;
  const marker = "`".repeat(width);
  const close = src.indexOf(marker, index + width);
  return close === -1 ? index + width : close + width;
}

function findBackslashClose(src, marker, from) {
  for (let i = from; i < src.length - 1; i += 1) {
    if (src[i] === "\n") return -1;
    if (src.startsWith(marker, i) && !isEscapedAt(src, i)) return i;
  }
  return -1;
}

function findDisplayBackslashClose(src, marker, from) {
  for (let i = from; i < src.length - 1; i += 1) {
    if (src.startsWith(marker, i) && !isEscapedAt(src, i)) return i;
  }
  return -1;
}

function validDollarOpen(src, index) {
  return src[index] === INLINE_DOLLAR && src[index + 1] !== INLINE_DOLLAR && !isWhitespace(src[index + 1]);
}

function findInlineDollarClose(src, from) {
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === "\n") return -1;
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (src[i] !== INLINE_DOLLAR) continue;
    if (src[i + 1] === INLINE_DOLLAR) return -1;
    if (isWhitespace(src[i - 1])) return -1;
    if (isDigit(src[i + 1])) return -1;
    return i;
  }
  return -1;
}

function findNextInlineMathStart(src) {
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "`") {
      i = findBacktickRunEnd(src, i) - 1;
      continue;
    }
    if (src.startsWith(BACKSLASH_OPEN_INLINE, i) && !isEscapedAt(src, i)) return i;
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (validDollarOpen(src, i)) return i;
  }
  return -1;
}

function findDisplayDollarClose(src, from) {
  for (let i = from; i < src.length - 1; i += 1) {
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (src.startsWith(DISPLAY_DOLLARS, i)) return i;
  }
  return -1;
}

function mathSourceCode(tex, displayMode) {
  const code = `<code class="math-source">${escapeHtml(tex)}</code>`;
  return displayMode ? `<p>${code}</p>\n` : code;
}

function renderMath(tex, displayMode) {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
    if (html.includes("katex-error")) return mathSourceCode(tex, displayMode);
    return displayMode ? `${html}\n` : html;
  } catch {
    return mathSourceCode(tex, displayMode);
  }
}

function renderPendingMath() {
  return '<div class="math-pending" aria-label="Typesetting math">Typesetting math...</div>\n';
}

function normalizeFenceLanguage(lang) {
  return String(lang || "").match(/\S+/)?.[0] || "";
}

function renderVisualPlaceholder(language, source) {
  const encoded = Buffer.from(String(source ?? ""), "utf8").toString("base64");
  return `<div class="viz" data-viz="${escapeHtml(language)}" data-src="${encoded}"></div>\n`;
}

function renderPendingVisual(language) {
  return `<div class="viz viz-pending" data-viz="${escapeHtml(language)}" aria-label="Drawing visual">Drawing…</div>\n`;
}

function findClosingFence(src, marker, from) {
  let lineStart = from;
  while (lineStart < src.length) {
    const lineEnd = src.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? src.length : lineEnd;
    const line = src.slice(lineStart, end);
    const match = /^(?: {0,3})(`{3,})[ \t]*$/.exec(line);
    if (match && match[1].length >= marker.length) return lineStart;
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return -1;
}

function renderRegisteredFence(language, source) {
  const render = fenceRenderers.get(language.toLowerCase());
  return render ? render(source, { language }) : null;
}

function renderPlainCode(source, language, escaped) {
  const code = source.replace(TRAILING_NEWLINE, "") + "\n";
  if (!language) {
    return `<pre><code>${escaped ? code : escapeHtml(code)}</code></pre>\n`;
  }
  return `<pre><code class="language-${escapeHtml(language)}">${escaped ? code : escapeHtml(code)}</code></pre>\n`;
}

function renderCodeFence({ text, lang, escaped }) {
  const language = normalizeFenceLanguage(lang);
  const registered = language ? renderRegisteredFence(language, text) : null;
  if (registered !== null) return registered;

  const hljsLanguage = hljs.getLanguage(language) ? language : language.toLowerCase();
  if (!language || !hljs.getLanguage(hljsLanguage)) return renderPlainCode(text, language, escaped);

  const source = text.replace(TRAILING_NEWLINE, "");
  const highlighted = hljs.highlight(source, { language: hljsLanguage, ignoreIllegals: true }).value + "\n";
  return `<pre><code class="language-${escapeHtml(language)} hljs">${highlighted}</code></pre>\n`;
}

const mathBlockExtension = {
  name: "mathBlock",
  level: "block",
  start(src) {
    const match = BLOCK_MATH_START.exec(src);
    if (!match) return undefined;
    return match.index + (match[0][0] === "\n" ? 1 : 0);
  },
  tokenizer(src) {
    const dollarOpen = /^(?: {0,3})\$\$(?!\$)[ \t]*/.exec(src);
    if (dollarOpen) {
      const bodyStart = dollarOpen[0].length;
      const close = findDisplayDollarClose(src, bodyStart);
      if (close === -1) {
        return { type: "mathBlock", raw: src, text: src.slice(bodyStart), pending: true };
      }
      return {
        type: "mathBlock",
        raw: src.slice(0, close + DISPLAY_DOLLARS.length),
        text: src.slice(bodyStart, close),
      };
    }

    const backslashOpen = /^(?: {0,3})\\\[[ \t]*/.exec(src);
    if (!backslashOpen) return undefined;
    const bodyStart = backslashOpen[0].length;
    const close = findDisplayBackslashClose(src, BACKSLASH_CLOSE_DISPLAY, bodyStart);
    if (close === -1) {
      return { type: "mathBlock", raw: src, text: src.slice(bodyStart), pending: true };
    }
    return {
      type: "mathBlock",
      raw: src.slice(0, close + BACKSLASH_CLOSE_DISPLAY.length),
      text: src.slice(bodyStart, close),
    };
  },
  renderer(token) {
    return token.pending ? renderPendingMath() : renderMath(token.text, true);
  },
};

const mathInlineExtension = {
  name: "mathInline",
  level: "inline",
  start(src) {
    const start = findNextInlineMathStart(src);
    return start === -1 ? undefined : start;
  },
  tokenizer(src) {
    if (src.startsWith(BACKSLASH_OPEN_INLINE) && !isEscapedAt(src, 0)) {
      const close = findBackslashClose(src, BACKSLASH_CLOSE_INLINE, BACKSLASH_OPEN_INLINE.length);
      if (close === -1) return undefined;
      return {
        type: "mathInline",
        raw: src.slice(0, close + BACKSLASH_CLOSE_INLINE.length),
        text: src.slice(BACKSLASH_OPEN_INLINE.length, close),
      };
    }

    if (!validDollarOpen(src, 0)) return undefined;
    const close = findInlineDollarClose(src, 1);
    if (close === -1) return undefined;
    return {
      type: "mathInline",
      raw: src.slice(0, close + INLINE_DOLLAR.length),
      text: src.slice(1, close),
    };
  },
  renderer(token) {
    return renderMath(token.text, false);
  },
};

const visualFencePendingExtension = {
  name: "visualFencePending",
  level: "block",
  start(src) {
    const match = VISUAL_FENCE_START.exec(src);
    if (!match) return undefined;
    return match.index + (match[0][0] === "\n" ? 1 : 0);
  },
  tokenizer(src) {
    const open = /^(?: {0,3})(`{3,})([^\n`]*)?(?:\n|$)/.exec(src);
    if (!open) return undefined;
    const language = normalizeFenceLanguage(open[2] || "").toLowerCase();
    if (!VISUAL_FENCE_LANGUAGES.has(language)) return undefined;
    if (findClosingFence(src, open[1], open[0].length) !== -1) return undefined;
    return { type: "visualFencePending", raw: src, language };
  },
  renderer(token) {
    return renderPendingVisual(token.language);
  },
};

function sanitizeUrl(href, allow) {
  if (!href) return null;
  // Validate the scheme against a stripped probe (so "java\tscript:" can't sneak
  // past), but return the ORIGINAL url when it passes — stripping the real url
  // would corrupt legitimate values like "https://example.com/a b".
  const probe = String(href).replace(URL_NOISE, "");
  return allow.test(probe) ? String(href) : null;
}

const renderer = {
  code(token) {
    return renderCodeFence(token);
  },
  html({ text }) {
    return escapeHtml(text);
  },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const resolved = resolveMarkdownUrl(href, { baseUrl: renderBaseUrl });
    const safe = sanitizeUrl(resolved, SAFE_URL);
    if (safe === null) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    // Open real links in a new tab so clicking one never navigates away from (and
    // thereby tears down) the Rabbithole page; keep in-page fragment links local.
    const target = safe.startsWith("#") ? "" : ` target="_blank"`;
    return `<a href="${escapeHtml(safe)}"${titleAttr}${target} rel="noopener noreferrer">${text}</a>`;
  },
  image({ href, title, text }) {
    const resolved = resolveMarkdownUrl(href, { baseUrl: renderBaseUrl, image: true, assetNames: renderAssetNames });
    const safe = sanitizeUrl(resolved, SAFE_IMG);
    if (safe === null) return escapeHtml(text || "");
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
  },
};

registerFenceRenderer("show", (source) => renderVisualPlaceholder("show", source));

marked.use({ extensions: [visualFencePendingExtension, mathBlockExtension, mathInlineExtension], renderer });

/** Renders markdown to safe HTML, collapsing inter-tag whitespace for compact embedding. */
export async function renderMarkdownToHtml(markdown, { baseUrl = null, assetNames = null } = {}) {
  const previousBaseUrl = renderBaseUrl;
  const previousAssetNames = renderAssetNames;
  renderBaseUrl = baseUrl;
  renderAssetNames = assetNames;
  try {
    const html = marked.parse(String(markdown ?? ""));
    return html.replace(/>\n+</g, "><").replace(/\n<\/code>/g, "</code>");
  } finally {
    renderBaseUrl = previousBaseUrl;
    renderAssetNames = previousAssetNames;
  }
}
