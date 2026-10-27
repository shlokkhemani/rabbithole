import { Marked } from "marked";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHtml } from "./utils.js";
import { resolveMarkdownUrl } from "./base-url.js";
import { getBlockType, listBlockTypes, parseBlockInfo } from "./blocks.js";

export const MARKDOWN_RENDERER_SENTINEL = "rabbithole-shared-markdown-renderer-v1";

const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
const SAFE_IMG = /^(?:https?:\/\/|\/|\.\/|\.\.\/|blob:|asset:[a-z0-9][a-z0-9_-]*\.(?:png|jpe?g|gif|webp|svg)$|data:image\/(?:png|jpe?g|gif|webp|svg(?:\+xml)?);base64,)/i;
// Whitespace/control chars used to obfuscate a scheme (e.g. "java\tscript:").
const URL_NOISE = new RegExp("[\\u0000-\\u0020]+", "g");
const INLINE_DOLLAR = "$";
const DISPLAY_DOLLARS = "$$";
const BACKSLASH_OPEN_INLINE = "\\(";
const BACKSLASH_CLOSE_INLINE = "\\)";
const BACKSLASH_CLOSE_DISPLAY = "\\]";
const TRAILING_NEWLINE = /\n$/;
const BLOCK_MATH_START = /(?:^|\n) {0,3}(?:\$\$(?!\$)|\\\[)/;
// GFM accepts either one or two tildes for deletion. A lone tilde is far more
// commonly approximation notation in pasted technical prose (`~77%`,
// `~1,000`) and can otherwise pair with a distant tilde to delete whole
// paragraphs. Rabbithole deliberately requires the unambiguous `~~text~~`
// spelling while retaining the rest of the GFM grammar.
/** @typedef {{ baseUrl: string | null, assetNames: Set<string> | null, resolveAssetUrl: (name: string) => string | null }} RenderContext */
/** @typedef {{ name: string, level: "block" | "inline", start(src: string): number | undefined, tokenizer(src: string): any, renderer(token: any): string }} RabbitholeExtension */

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("r", r);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** @param {string | undefined} ch */
function isWhitespace(ch) {
  return ch === undefined || /\s/.test(ch);
}

/** @param {string | undefined} ch */
function isDigit(ch) {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/** @param {string} src @param {number} index */
function isEscapedAt(src, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && src[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

/** @param {string} src @param {number} index */
function findBacktickRunEnd(src, index) {
  let width = 1;
  while (src[index + width] === "`") width += 1;
  const marker = "`".repeat(width);
  const close = src.indexOf(marker, index + width);
  return close === -1 ? index + width : close + width;
}

/** @param {string} src @param {string} marker @param {number} from */
function findBackslashClose(src, marker, from) {
  for (let i = from; i < src.length - 1; i += 1) {
    if (src[i] === "\n") return -1;
    if (src.startsWith(marker, i) && !isEscapedAt(src, i)) return i;
  }
  return -1;
}

/** @param {string} src @param {string} marker @param {number} from */
function findDisplayBackslashClose(src, marker, from) {
  for (let i = from; i < src.length - 1; i += 1) {
    if (src.startsWith(marker, i) && !isEscapedAt(src, i)) return i;
  }
  return -1;
}

/** @param {string} src @param {number} index */
function validDollarOpen(src, index) {
  return src[index] === INLINE_DOLLAR && src[index + 1] !== INLINE_DOLLAR && !isWhitespace(src[index + 1]);
}

/** @param {string} src @param {number} from */
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

/** @param {string} src */
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

/** @param {string} src @param {number} from */
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

/**
 * Marked asks a block extension where it could next start only to cut the
 * paragraph it is reading short there, and a blank line ends that paragraph
 * first. Looking no further keeps a long document's parse linear: searching
 * the whole rest of the document from every paragraph is quadratic.
 * @param {string} src
 */
function paragraphWindow(src) {
  const blank = src.indexOf("\n\n");
  return blank === -1 ? src : src.slice(0, blank);
}

/** @param {string} tex @param {boolean} displayMode */
function mathSourceCode(tex, displayMode) {
  const code = `<code class="math-source">${escapeHtml(tex)}</code>`;
  return displayMode ? `<p>${code}</p>\n` : code;
}

/** @param {string} tex @param {boolean} displayMode */
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

/** @param {string | null} id */
function blockIdAttribute(id) {
  return id ? ` data-block-id="${escapeHtml(id)}"` : "";
}

/** @param {string} language @param {string | null} id */
function renderPendingVisual(language, id) {
  return `<div class="viz viz-pending" data-viz="${escapeHtml(language)}"${blockIdAttribute(id)} aria-label="Drawing visual">Drawing…</div>\n`;
}

/** @param {string} src @param {string} marker @param {number} from */
function findClosingFence(src, marker, from) {
  let lineStart = from;
  while (lineStart < src.length) {
    const lineEnd = src.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? src.length : lineEnd;
    const line = src.slice(lineStart, end);
    const match = /^(?: {0,3})(`{3,})[ \t]*$/.exec(line);
    if (match && (match[1]?.length ?? 0) >= marker.length) return lineStart;
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return -1;
}

/** @param {string} source @param {string} language @param {boolean | undefined} escaped */
function renderPlainCode(source, language, escaped) {
  const code = source.replace(TRAILING_NEWLINE, "") + "\n";
  if (!language) {
    return `<pre><code>${escaped ? code : escapeHtml(code)}</code></pre>\n`;
  }
  return `<pre><code class="language-${escapeHtml(language)}">${escaped ? code : escapeHtml(code)}</code></pre>\n`;
}

/** @param {unknown} href @param {RegExp} allow */
function sanitizeUrl(href, allow) {
  if (!href) return null;
  // Validate the scheme against a stripped probe (so "java\tscript:" can't sneak
  // past), but return the ORIGINAL url when it passes. Stripping the real url
  // would corrupt legitimate values like "https://example.com/a b".
  const probe = String(href).replace(URL_NOISE, "");
  return allow.test(probe) ? String(href) : null;
}

/** @param {unknown} href */
export function sanitizeMarkdownLinkUrl(href) {
  return sanitizeUrl(href, SAFE_URL);
}

/** @param {unknown} href */
export function sanitizeMarkdownImageUrl(href) {
  return sanitizeUrl(href, SAFE_IMG);
}

/** @returns {never} */
function defaultEncodeBase64() {
  throw new Error("Markdown renderer requires an encodeBase64 adapter for visual fences");
}

function defaultAssetUrlResolver() {
  return null;
}

/** @param {{ encodeBase64?: (source: string) => string, resolveAssetUrl?: (name: string) => string | null }} [adapters] */
export function createMarkdownRenderer({ encodeBase64 = defaultEncodeBase64, resolveAssetUrl = defaultAssetUrlResolver } = {}) {
  const registeredTypes = new Set(listBlockTypes().map(({ type }) => type));
  const escapedTypes = [...registeredTypes].map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const visualFenceStart = escapedTypes.length
    ? new RegExp(`(?:^|\\n) {0,3}\`{3,}[ \\t]*(?:${escapedTypes.join("|")})(?=$|[ \\t\\n])`, "i")
    : null;

  /** @param {string} language @param {string} source @param {string | null} id */
  function renderVisualPlaceholder(language, source, id) {
    const encoded = encodeBase64(String(source ?? ""));
    return `<div class="viz" data-viz="${escapeHtml(language)}" data-src="${encoded}"${blockIdAttribute(id)}></div>\n`;
  }

  /** @param {string} language @param {string} source @param {string | null} id */
  function renderRegisteredFence(language, source, id) {
    const descriptor = getBlockType(language);
    if (!descriptor || !registeredTypes.has(descriptor.type)) return null;
    descriptor.parse(source);
    return renderVisualPlaceholder(descriptor.type, source, id);
  }

  /** @param {{ text: string, lang?: string, escaped?: boolean }} token */
  function renderCodeFence({ text, lang, escaped }) {
    const info = parseBlockInfo(lang);
    const language = info.type;
    const registered = language ? renderRegisteredFence(language, text, info.id) : null;
    if (registered !== null) return registered;

    const hljsLanguage = hljs.getLanguage(language) ? language : language.toLowerCase();
    if (!language || !hljs.getLanguage(hljsLanguage)) return renderPlainCode(text, language, escaped);

    const source = text.replace(TRAILING_NEWLINE, "");
    const highlighted = hljs.highlight(source, { language: hljsLanguage, ignoreIllegals: true }).value + "\n";
    return `<pre><code class="language-${escapeHtml(language)} hljs">${highlighted}</code></pre>\n`;
  }

  /** @returns {RabbitholeExtension[]} */
  function buildExtensions() {
    return [
      {
        name: "visualFencePending",
        level: "block",
        start(src) {
          const match = visualFenceStart?.exec(paragraphWindow(src));
          if (!match) return undefined;
          return match.index + (match[0][0] === "\n" ? 1 : 0);
        },
        tokenizer(src) {
          const open = /^(?: {0,3})(`{3,})([^\n`]*)?(?:\n|$)/.exec(src);
          if (!open) return undefined;
          const info = parseBlockInfo(open[2]);
          const language = info.type;
          if (!registeredTypes.has(language)) return undefined;
          if (findClosingFence(src, open[1] ?? "", open[0].length) !== -1) return undefined;
          return { type: "visualFencePending", raw: src, language, blockId: info.id };
        },
        renderer(token) {
          return renderPendingVisual(token.language, token.blockId);
        },
      },
      {
        name: "mathBlock",
        level: "block",
        start(src) {
          const match = BLOCK_MATH_START.exec(paragraphWindow(src));
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
      },
      {
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
      },
    ];
  }

  /** @param {() => RenderContext} currentContext @returns {import("marked").RendererObject} */
  function buildRenderer(currentContext) {
    return {
      code(token) {
        return renderCodeFence(token);
      },
      html({ text }) {
        // Scientific prose needs scripts without invoking math mode. Only the
        // attribute-free tags are admitted; all other source HTML stays inert.
        if (/^<\/?(?:sup|sub)>$/i.test(text)) return text.toLowerCase();
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const context = currentContext();
        const text = this.parser.parseInline(tokens);
        const resolved = resolveMarkdownUrl(href, { baseUrl: context.baseUrl });
        const safe = sanitizeUrl(resolved, SAFE_URL);
        if (safe === null) return text;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // Open real links in a new tab so clicking one never navigates away from
        // and tears down the Rabbithole page; keep in-page fragment links local.
        const target = safe.startsWith("#") ? "" : ` target="_blank"`;
        return `<a href="${escapeHtml(safe)}"${titleAttr}${target} rel="noopener noreferrer">${text}</a>`;
      },
      image({ href, title, text }) {
        const context = currentContext();
        const resolved = resolveMarkdownUrl(href, {
          baseUrl: context.baseUrl,
          image: true,
          assetNames: context.assetNames,
          resolveAssetUrl: context.resolveAssetUrl,
        });
        const safe = sanitizeUrl(resolved, SAFE_IMG);
        if (safe === null) return escapeHtml(text || "");
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        const pastedAttr = /^asset:paste-[a-f0-9-]+\.(?:png|jpg)$/.test(String(href))
          ? ' data-rh-pasted="1"' : "";
        return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || "")}"${titleAttr}${pastedAttr}>`;
      },
    };
  }

  /** @returns {import("marked").TokenizerObject} */
  function buildTokenizer() {
    return {
      del(src) {
        // Marked tokenizer overrides fall back to the native tokenizer only
        // when they return false. Delegate double tildes so Marked remains the
        // authority for delimiter edge cases; consume no single-tilde token.
        return src.startsWith("~~") ? false : undefined;
      },
    };
  }

  /** @type {RenderContext} */
  let activeContext = { baseUrl: null, assetNames: null, resolveAssetUrl };
  // A renderer instance is immutable after configuration. Reusing it avoids
  // rebuilding Marked's extension registry and parser options on every stream
  // frame; the per-call URL/asset context remains scoped to the synchronous
  // parse below.
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: buildExtensions(),
    renderer: buildRenderer(() => activeContext),
    tokenizer: buildTokenizer(),
  });

  /** @param {unknown} markdown @param {{ baseUrl?: string | null, assetNames?: Set<string> | null, resolveAssetUrl?: ((name: string) => string | null) | null }} [options] */
  function renderMarkdownToHtml(markdown, { baseUrl = null, assetNames = null, resolveAssetUrl: perCallResolver = null } = {}) {
    const previousContext = activeContext;
    activeContext = {
      baseUrl,
      assetNames,
      resolveAssetUrl: perCallResolver || resolveAssetUrl,
    };
    try {
      const html = /** @type {string} */ (marked.parse(String(markdown ?? "")));
      return html.replace(/>\n+</g, "><").replace(/\n<\/code>/g, "</code>");
    } finally {
      activeContext = previousContext;
    }
  }

  /**
   * How much of `markdown`, an answer still being written, has settled: its
   * leading blocks up to a blank line before the last block. No text appended
   * later can change those (a blank line closes every block that cannot
   * contain one, and an open fence, math block or list is always the last
   * block). -1 when a link reference definition can still change text
   * anywhere in it.
   * @param {unknown} markdown
   */
  function settledMarkdownLength(markdown) {
    const src = String(markdown ?? "");
    // Marked normalizes line endings, so its token lengths would not add up.
    if (src.includes("\r")) return 0;
    const lexer = new marked.Lexer(marked.defaults);
    const tokens = lexer.blockTokens(src, []);
    if (Object.keys(lexer.tokens.links).length) return -1;
    let end = 0;
    let lastBlock = 0;
    const starts = [];
    for (const token of tokens) {
      starts.push(end);
      if (token.type !== "space") lastBlock = end;
      end += token.raw.length;
    }
    if (end !== src.length) return 0;
    let settled = 0;
    for (const start of starts) {
      if (start > lastBlock) break;
      if (start >= 2 && src.startsWith("\n\n", start - 2)) settled = start;
    }
    return settled;
  }

  return {
    renderMarkdownToHtml,
    settledMarkdownLength,
  };
}
