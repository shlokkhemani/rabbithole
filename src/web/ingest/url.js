import { MAX_PDF_BYTES } from "../../core/pdf-shared.js";
import { createHoleFromMarkdown } from "../transport/direct-host.js";
import { ingestPdfToStoredHole } from "./pdf.js";

const URL_FETCH_CAP_BYTES = 25 * 1024 * 1024;
const PASTE_FALLBACK = "Try another link or open a PDF file instead.";

export async function openUrlToStoredHole({ rawUrl, store, title = "", proxyBaseUrl = "", transformMarkdown = null, onProgress = null } = {}) {
  const inputUrl = normalizeInputUrl(rawUrl);
  const preferred = preferredHtmlUrl(inputUrl) || inputUrl;
  onProgress?.({ phase: "fetch", url: preferred.href, via: "direct" });

  let fetched;
  try {
    fetched = await fetchWithProxyFallback(preferred, { proxyBaseUrl, capBytes: URL_FETCH_CAP_BYTES, onProgress });
  } catch (err) {
    throw fallbackError(err);
  }

  const contentType = fetched.contentType;
  const isPdf = isPdfResponse(fetched.url, contentType, fetched.bytes);
  if (isPdf) {
    return ingestPdfToStoredHole({
      source: fetched.bytes,
      store,
      title: title || titleFromUrl(inputUrl),
      baseUrl: fetched.url.href,
      onProgress,
    });
  }

  const extracted = htmlToMarkdown(new TextDecoder("utf-8").decode(fetched.bytes), fetched.url);
  if (!extracted.markdown) {
    throw new Error(`Couldn't extract readable article content from that URL. ${PASTE_FALLBACK}`);
  }
  const holeTitle = title || extracted.title || titleFromUrl(fetched.url) || "Web Document";
  const markdown = typeof transformMarkdown === "function"
    ? await transformMarkdown({ markdown: extracted.markdown, title: holeTitle, baseUrl: fetched.url.href })
    : extracted.markdown;
  const hole = createHoleFromMarkdown({ title: holeTitle, markdown, baseUrl: fetched.url.href });
  await store.saveHole(hole);
  return { hole, result: { title: holeTitle, url: fetched.url.href, via: fetched.via } };
}

async function fetchWithProxyFallback(url, { proxyBaseUrl, capBytes, onProgress } = {}) {
  try {
    return await fetchUrl(url, { capBytes, via: "direct" });
  } catch {
    if (!proxyBaseUrl) {
      throw new Error(`This site blocks fetching from inside the browser, and no link relay is set in Settings → Advanced. ${PASTE_FALLBACK}`);
    }
    onProgress?.({ phase: "fetch", url: url.href, via: "proxy" });
    try {
      return await fetchUrl(proxyUrl(proxyBaseUrl, url), { capBytes, via: "proxy", finalUrl: url });
    } catch (proxyErr) {
      if (proxyErr?.status === 400) {
        throw new Error(`This site isn't supported by the link relay yet — arXiv links work best. ${PASTE_FALLBACK}`);
      }
      const status = proxyErr?.status ? ` (HTTP ${proxyErr.status})` : "";
      throw new Error(`That page couldn't be fetched right now${status}. ${PASTE_FALLBACK}`);
    }
  }
}

async function fetchUrl(url, { capBytes, via, finalUrl = null } = {}) {
  const response = await fetch(url.href, {
    method: "GET",
    credentials: "omit",
    headers: { Accept: "text/html,application/pdf;q=0.9,text/plain;q=0.5,*/*;q=0.1" },
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    err.status = response.status;
    throw err;
  }
  const contentType = response.headers.get("content-type") || "";
  const limit = /application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(url.pathname)
    ? MAX_PDF_BYTES
    : capBytes;
  const bytes = await readResponseBytes(response, limit);
  return {
    bytes,
    contentType,
    url: finalUrl || responseUrl(response, url),
    via,
  };
}

async function readResponseBytes(response, capBytes) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > capBytes) throw new Error(`Response exceeds the ${formatMb(capBytes)} limit.`);
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes) throw new Error(`Response exceeds the ${formatMb(capBytes)} limit.`);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds the ${formatMb(capBytes)} limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function preferredHtmlUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "arxiv.org" || host === "www.arxiv.org") {
    let id = "";
    const abs = /^\/abs\/([^/?#]+)/.exec(path);
    const pdf = /^\/pdf\/([^/?#]+?)(?:\.pdf)?$/.exec(path);
    if (abs) id = abs[1];
    else if (pdf) id = pdf[1];
    if (id) return new URL(`/html/${id}`, "https://ar5iv.labs.arxiv.org");
  }
  return null;
}

function htmlToMarkdown(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = textOf(doc.querySelector("meta[property='og:title']")?.getAttribute("content")) ||
    textOf(doc.querySelector("h1")?.textContent) ||
    textOf(doc.title);
  const root = doc.querySelector("article") ||
    doc.querySelector("main") ||
    doc.querySelector(".ltx_document") ||
    doc.querySelector("#content") ||
    doc.body;
  if (!root) return { title, markdown: "" };
  const clone = root.cloneNode(true);
  clone.querySelectorAll("script,style,noscript,template,nav,header,footer,form,iframe,svg").forEach((el) => el.remove());

  const blocks = [];
  if (title) blocks.push(`# ${cleanLine(title)}`, "");
  walkHtml(clone, blocks, baseUrl);
  const markdown = blocks.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  const plain = markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "").replace(/[#*_`>\-[\]()]/g, "").trim();
  if (plain.length < 80 && !/!\[[^\]]*]\([^)]+\)/.test(markdown)) return { title, markdown: "" };
  return { title, markdown: markdown + "\n" };
}

function walkHtml(node, blocks, baseUrl) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(Number(tag.slice(1)) || 2, 6);
      const text = cleanLine(child.textContent);
      if (text) blocks.push(`${"#".repeat(level)} ${text}`, "");
      continue;
    }
    if (tag === "img") {
      const src = child.getAttribute("src") || child.getAttribute("data-src");
      const absolute = absoluteHttpUrl(src, baseUrl);
      if (absolute) {
        const alt = cleanLine(child.getAttribute("alt") || "image");
        blocks.push(`![${alt}](${absolute})`, "");
      }
      continue;
    }
    if (tag === "li") {
      const text = inlineMarkdown(child, baseUrl);
      if (text) blocks.push(`- ${text}`);
      continue;
    }
    if (["p", "blockquote", "figcaption", "pre"].includes(tag)) {
      const text = inlineMarkdown(child, baseUrl);
      if (text) blocks.push(tag === "blockquote" ? `> ${text}` : text, "");
      continue;
    }
    if (["article", "main", "section", "div", "body", "ul", "ol", "figure"].includes(tag)) {
      walkHtml(child, blocks, baseUrl);
    }
  }
}

function inlineMarkdown(node, baseUrl) {
  const out = [];
  function visit(current) {
    if (current.nodeType === Node.TEXT_NODE) {
      out.push(current.nodeValue || "");
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    const tag = current.tagName.toLowerCase();
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "img") {
      const src = absoluteHttpUrl(current.getAttribute("src") || current.getAttribute("data-src"), baseUrl);
      if (src) out.push(`![${cleanLine(current.getAttribute("alt") || "image")}](${src})`);
      return;
    }
    if (tag === "a") {
      const text = cleanLine(current.textContent);
      const href = absoluteHttpUrl(current.getAttribute("href"), baseUrl);
      if (text && href) out.push(`[${text}](${href})`);
      else if (text) out.push(text);
      return;
    }
    for (const child of current.childNodes) visit(child);
  }
  visit(node);
  return cleanLine(out.join(""));
}

function isPdfResponse(url, contentType, bytes) {
  if (/application\/pdf/i.test(contentType || "")) return true;
  if (/\.pdf(?:$|[?#])/i.test(url.pathname)) return true;
  return bytes?.byteLength >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes.byteLength <= MAX_PDF_BYTES;
}

function proxyUrl(proxyBaseUrl, targetUrl) {
  const proxy = new URL(proxyBaseUrl, location.href);
  if (proxy.href.includes("{url}")) return new URL(proxy.href.replace("{url}", encodeURIComponent(targetUrl.href)));
  proxy.searchParams.set("url", targetUrl.href);
  return proxy;
}

function normalizeInputUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error("Enter a URL first.");
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be opened.");
  return url;
}

function responseUrl(response, fallback) {
  try {
    return response.url ? new URL(response.url) : fallback;
  } catch {
    return fallback;
  }
}

function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ""), baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function fallbackError(err) {
  const message = messageOf(err);
  return message.includes(PASTE_FALLBACK) ? err : new Error(`${message} ${PASTE_FALLBACK}`);
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function titleFromUrl(url) {
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname).replace(/[-_]+/g, " ");
}

function textOf(value) {
  return cleanLine(value || "");
}

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatMb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
