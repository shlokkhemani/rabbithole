import { resolveMarkdownUrl } from "../core/base-url.js";
import { sanitizeMarkdownImageUrl, sanitizeMarkdownLinkUrl } from "../core/markdown-renderer.js";
import { renderMarkdownForSurface, resolveAssetUrl } from "./renderer.js";

function escapeText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1");
}

function decodeUtf8Base64(value) {
  try {
    const binary = atob(String(value || ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return "";
  }
}

function compactBlocks(parts) {
  return parts
    .map((part) => String(part || "").trimEnd())
    .filter(Boolean)
    .join("\n\n");
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node;
  if (element.matches("button, .code-copy, .rh-img-handle")) return "";
  if (element.matches(".rh-img-frame")) return inlineMarkdown(element.querySelector("img"));
  if (element.matches(".katex, .katex-display") && element.dataset.mathSource != null) {
    return element.matches(".katex-display")
      ? "$$\n" + element.dataset.mathSource + "\n$$"
      : "$" + element.dataset.mathSource + "$";
  }
  if (element.matches("img")) {
    const raw = element.dataset.markdownSrc || element.getAttribute("src") || "";
    const source = raw.startsWith("/assets/") ? "asset:" + raw.slice("/assets/".length) : raw;
    const title = element.getAttribute("title");
    return (
      "![" +
      String(element.getAttribute("alt") || "").replace(/]/g, "\\]") +
      "](" +
      source +
      (title ? ' "' + title.replace(/"/g, '\\"') + '"' : "") +
      ")"
    );
  }
  if (element.matches("br")) return "  \n";
  const content = Array.from(element.childNodes, inlineMarkdown).join("");
  if (element.matches("strong, b")) return "**" + content + "**";
  if (element.matches("em, i")) return "*" + content + "*";
  if (element.matches("del, s, strike")) return "~~" + content + "~~";
  if (element.matches("sup, sub")) {
    const tag = element.tagName.toLowerCase();
    return "<" + tag + ">" + content + "</" + tag + ">";
  }
  if (element.matches("code") && !element.closest("pre")) return "`" + content.replace(/`/g, "\\`") + "`";
  if (element.matches("a")) {
    const href = element.dataset.markdownHref || element.getAttribute("href") || "";
    const title = element.getAttribute("title");
    return "[" + content + "](" + href + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : "") + ")";
  }
  return content;
}

function listMarkdown(list) {
  const ordered = list.tagName === "OL";
  const start = Number(list.getAttribute("start")) || 1;
  return Array.from(list.children)
    .filter((child) => child.tagName === "LI")
    .map((item, index) => {
      const nested = Array.from(item.children).filter((child) => child.matches("ul, ol"));
      const body = Array.from(item.childNodes)
        .filter((child) => !nested.includes(child))
        .map(inlineMarkdown)
        .join("")
        .trim();
      const marker = ordered ? String(start + index) + ". " : "- ";
      const continuation = nested
        .map((child) =>
          listMarkdown(child)
            .split("\n")
            .map((line) => "  " + line)
            .join("\n"),
        )
        .join("\n");
      return marker + body + (continuation ? "\n" + continuation : "");
    })
    .join("\n");
}

function tableMarkdown(table) {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const values = rows.map((row) =>
    Array.from(row.children).map((cell) => inlineMarkdown(cell).trim().replace(/\|/g, "\\|")),
  );
  const width = Math.max(...values.map((row) => row.length));
  const line = (row) => "| " + Array.from({ length: width }, (_unused, index) => row[index] || "").join(" | ") + " |";
  return [line(values[0]), line(Array(width).fill("---")), ...values.slice(1).map(line)].join("\n");
}

function blockMarkdown(element) {
  if (element.matches(".viz[data-viz]")) {
    const id = element.dataset.blockId ? " id=" + element.dataset.blockId : "";
    return "```" + element.dataset.viz + id + "\n" + decodeUtf8Base64(element.dataset.src) + "\n```";
  }
  if (element.matches(".katex-display[data-math-source]")) return "$$\n" + element.dataset.mathSource + "\n$$";
  if (element.matches("h1, h2, h3, h4, h5, h6"))
    return "#".repeat(Number(element.tagName.slice(1))) + " " + inlineMarkdown(element).trim();
  if (element.matches("p")) return inlineMarkdown(element).trimEnd();
  if (element.matches("pre")) {
    const code = element.querySelector("code");
    const language =
      Array.from(code?.classList || [])
        .find((name) => name.startsWith("language-"))
        ?.slice(9) || "";
    return (
      "```" + language + "\n" + String(code?.textContent || element.textContent || "").replace(/\n$/, "") + "\n```"
    );
  }
  if (element.matches("ul, ol")) return listMarkdown(element);
  if (element.matches("blockquote"))
    return compactBlocks(Array.from(element.children, blockMarkdown))
      .split("\n")
      .map((line) => "> " + line)
      .join("\n");
  if (element.matches("table")) return tableMarkdown(element);
  if (element.matches("hr")) return "---";
  if (element.matches(".rh-img-frame, img")) return inlineMarkdown(element);
  return inlineMarkdown(element).trimEnd();
}

export function serializeStructuredNote(element) {
  return compactBlocks(Array.from(element.children, blockMarkdown));
}

function annotateSourceMetadata(element, markdown) {
  const source = String(markdown || "");
  const imageSources = Array.from(source.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), (match) => match[1]);
  element.querySelectorAll("img").forEach((image, index) => {
    if (imageSources[index]) image.dataset.markdownSrc = imageSources[index];
  });
  const linkSources = Array.from(source.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), (match) => match[1]);
  element.querySelectorAll("a[href]").forEach((link, index) => {
    if (linkSources[index]) link.dataset.markdownHref = linkSources[index];
  });
  const displayMath = Array.from(
    source.matchAll(/(?:\$\$\s*([\s\S]*?)\s*\$\$|\\\[\s*([\s\S]*?)\s*\\\])/g),
    (match) => match[1] ?? match[2] ?? "",
  );
  element.querySelectorAll(":scope > .katex-display, :scope > p > .katex-display").forEach((math, index) => {
    if (displayMath[index] != null) math.dataset.mathSource = displayMath[index];
  });
  const withoutDisplay = source.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g, "");
  const inlineMath = Array.from(
    withoutDisplay.matchAll(/(?:\$([^$\n]+)\$|\\\((.+?)\\\))/g),
    (match) => match[1] ?? match[2] ?? "",
  );
  element.querySelectorAll(".katex:not(.katex-display .katex)").forEach((math, index) => {
    if (inlineMath[index] != null) math.dataset.mathSource = inlineMath[index];
  });
}

/** One persistent DOM surface. Read/edit changes only contenteditable and a caret. */
export function mountStructuredNote(element, options) {
  let editable = !!options?.editable;
  let markdown = String(options?.markdown || "");
  let onChange = options?.onChange || null;
  let destroyed = false;

  function render(source, notify) {
    markdown = String(source || "");
    element.innerHTML = renderMarkdownForSurface(markdown, { baseUrl: options?.baseUrl || null });
    annotateSourceMetadata(element, markdown);
    options?.onReplace?.(element);
    if (notify) onChange?.(markdown, { docChanged: true });
  }
  function changed() {
    markdown = serializeStructuredNote(element);
    onChange?.(markdown, { docChanged: true });
  }
  function keydown(event) {
    if (!editable) return;
    if ((event.metaKey || event.ctrlKey) && ["b", "i"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      document.execCommand(event.key.toLowerCase() === "b" ? "bold" : "italic");
      changed();
    } else if (event.key === "Tab" && event.target.closest?.("li")) {
      event.preventDefault();
      document.execCommand(event.shiftKey ? "outdent" : "indent");
      changed();
    }
  }
  function click(event) {
    if (editable) return;
    const link = event.target?.closest?.("a[href]");
    if (!link) return;
    event.preventDefault();
    const href = sanitizeMarkdownLinkUrl(
      resolveMarkdownUrl(link.dataset.markdownHref || link.getAttribute("href"), { baseUrl: options?.baseUrl || null }),
    );
    if (href) window.open(href, href.startsWith("#") ? "_self" : "_blank", "noopener,noreferrer");
  }
  element.addEventListener("input", changed);
  element.addEventListener("keydown", keydown);
  element.addEventListener("click", click);
  element.classList.add("structured-note");
  element.setAttribute("aria-label", options?.ariaLabel || "Note");
  if (options?.html != null) {
    element.innerHTML = options.html;
    annotateSourceMetadata(element, markdown);
  } else render(markdown, false);
  element.contentEditable = editable ? "true" : "false";

  const controller = {
    element,
    get editable() {
      return editable;
    },
    get markdown() {
      return markdown;
    },
    setEditable(value) {
      editable = !!value;
      element.classList.toggle("note-editor", editable);
      element.contentEditable = editable ? "true" : "false";
      element.setAttribute(
        "aria-label",
        editable ? options?.editAriaLabel || "Edit note" : options?.ariaLabel || "Note",
      );
      if (editable) element.focus({ preventScroll: true });
    },
    replaceMarkdown(source) {
      render(source, false);
    },
    setOnChange(callback) {
      onChange = typeof callback === "function" ? callback : null;
    },
    focusAt() {
      this.setEditable(true);
      placeCaret(element, false);
    },
    focusAtCoords(left, top) {
      this.setEditable(true);
      const range = document.caretRangeFromPoint?.(Number(left) || 0, Number(top) || 0);
      const selection = window.getSelection();
      if (range && element.contains(range.startContainer)) {
        selection.removeAllRanges();
        selection.addRange(range);
      } else placeCaret(element, false);
    },
    insertImage(source, alt) {
      const raw = String(source || "");
      const image = document.createElement("img");
      image.dataset.markdownSrc = raw;
      image.src = sanitizeMarkdownImageUrl(raw.startsWith("asset:") ? resolveAssetUrl(raw.slice(6)) : raw) || "data:,";
      image.alt = alt || "Pasted image";
      if (/^asset:paste-[a-f0-9-]+\.(?:png|jpg)$/.test(raw)) image.dataset.rhPasted = "1";
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && element.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(image);
        range.setStartAfter(image);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else element.appendChild(image);
      changed();
      element.focus({ preventScroll: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener("input", changed);
      element.removeEventListener("keydown", keydown);
      element.removeEventListener("click", click);
      delete element._rhStructuredNote;
    },
  };
  element._rhStructuredNote = controller;
  return controller;
}

function placeCaret(element, atStart) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(!!atStart);
  selection.removeAllRanges();
  selection.addRange(range);
  element.focus({ preventScroll: true });
}

export function structuredNoteController(element) {
  return element?._rhStructuredNote || null;
}
