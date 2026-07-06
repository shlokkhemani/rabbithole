import { marked } from "marked";
import katex from "katex";
import { escapeHtml } from "./utils.js";

marked.setOptions({ gfm: true, breaks: false });

// Render embedded LaTeX to MathML (KaTeX's font-free output path) so the canvas
// page stays self-contained — no stylesheet or webfont files. See html/README.md.
function renderMath(tex, displayMode) {
  let html;
  try {
    // Drop KaTeX's <annotation> (a hidden copy of the raw TeX): it renders
    // nothing but doubles the formula's text content, which would bloat the
    // selection quotes and offset space the reader anchors highlights against.
    html = katex
      .renderToString(String(tex), {
        output: "mathml",
        displayMode,
        throwOnError: false,
        strict: "ignore",
      })
      .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/, "");
  } catch {
    // Never let one bad formula take down the whole render; show the literal TeX.
    html = `<code>${escapeHtml(String(tex))}</code>`;
  }
  return displayMode ? `<div class="math-display">${html}</div>` : html;
}

// Tokenizers, not a regex pre-pass, so math inside code spans/fences stays literal.
const mathExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(src) {
        return src.match(/\$\$|\\\[/)?.index;
      },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
        if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
      },
      renderer(token) {
        return renderMath(token.text, true);
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(src) {
        return src.match(/\$|\\\(/)?.index;
      },
      tokenizer(src) {
        let m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: "mathInline", raw: m[0], text: m[1].trim() };
        // No surrounding spaces, closer not before a digit: keeps "$5 and $10"
        // plain. Content also can't cross a backtick or newline, so an inline
        // "$" can't reach past a code span (`$x$`) or into the next line.
        m = /^\$(?!\$)((?:[^$\\`\n]|\\.)+?)\$(?!\d)/.exec(src);
        if (m && !/^\s|\s$/.test(m[1])) {
          return { type: "mathInline", raw: m[0], text: m[1].trim() };
        }
      },
      renderer(token) {
        return renderMath(token.text, false);
      },
    },
  ],
};

marked.use(mathExtension);

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

function sanitizeUrl(href, allow) {
  if (!href) return null;
  // Validate the scheme against a stripped probe (so "java\tscript:" can't sneak
  // past), but return the ORIGINAL url when it passes — stripping the real url
  // would corrupt legitimate values like "https://example.com/a b".
  const probe = String(href).replace(URL_NOISE, "");
  return allow.test(probe) ? String(href) : null;
}

const renderer = {
  html({ text }) {
    return escapeHtml(text);
  },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const safe = sanitizeUrl(href, SAFE_URL);
    if (safe === null) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    // Open real links in a new tab so clicking one never navigates away from (and
    // thereby tears down) the Rabbithole page; keep in-page fragment links local.
    const target = safe.startsWith("#") ? "" : ` target="_blank"`;
    return `<a href="${escapeHtml(safe)}"${titleAttr}${target} rel="noopener noreferrer">${text}</a>`;
  },
  image({ href, title, text }) {
    const safe = sanitizeUrl(href, SAFE_IMG);
    if (safe === null) return escapeHtml(text || "");
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
  },
};

marked.use({ renderer });

/** Renders markdown to safe HTML, collapsing inter-tag whitespace for compact embedding. */
export async function renderMarkdownToHtml(markdown) {
  const html = await marked.parse(String(markdown ?? ""));
  return html.replace(/>\n+</g, "><").replace(/\n<\/code>/g, "</code>");
}
