import { ATTACHMENT_LIMIT_MESSAGE, MAX_ASK_ATTACHMENTS } from "../../core/attachments.js";
import { wirePastedImages } from "../authoring/note-editor.js";
import { createStandaloneNoteSubmitter } from "../authoring/standalone-note-submit.js";
import { normalizeClipboardImage } from "../clipboard-image.js";
import { wireComposerActions } from "../composer-state.js";
import { deleteAsset, flashHint } from "../core.js";
import { createCleanupScope } from "../kit/scope.js";
import { teardownNode } from "../node-teardown.js";
import {
  growStandaloneNoteComposer,
  noteCommitFromEnter,
  noteComposerActions,
  updateStandaloneNoteComposer,
} from "./document.js";
import { r } from "./runtime.js";
import { clipboardImageFiles, flashClipboardImageError } from "./shared.js";

export function startStandaloneNoteComposer(node, dc) {
  const scope = createCleanupScope();
  const composer = document.createElement("div");
  composer.className = "nc-inner followup-composer";
  const input = document.createElement("div");
  input.className = "ask-input";
  const editor = document.createElement("textarea");
  editor.className = "note-editor md";
  editor.rows = 1;
  editor.dataset.nodeId = node.id;
  editor.dataset.surface = dc.dataset.surface || "canvas";
  editor.setAttribute("aria-label", "Ask or write a note");
  editor.spellcheck = true;
  editor.value = node.markdown || "";
  editor.style.fontSize = dc.style.fontSize;
  const attachmentStrip = document.createElement("div");
  attachmentStrip.className = "paste-attachment-strip";
  attachmentStrip.hidden = true;
  const actions = noteComposerActions();
  input.appendChild(editor);
  composer.appendChild(input);
  composer.appendChild(attachmentStrip);
  composer.appendChild(actions);
  dc.replaceWith(composer);
  node._noteEditor = editor;
  node._noteComposer = composer;
  node._noteActions = actions;
  node._noteInput = input;
  node._noteAttachmentStrip = attachmentStrip;
  const attachments = [];
  node._noteAttachments = attachments;
  const uploadedNames = new Set();
  node._noteUploadedAssets = uploadedNames;
  let pendingAssetCleanup = Promise.resolve();
  function releaseAttachment(attachment) {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  function releaseAttachments() {
    attachments.splice(0).forEach(releaseAttachment);
  }
  scope.addCleanup(releaseAttachments);
  node._noteDraftDispose = scope.dispose;
  node._noteDockedComposer = node.ncComp;
  if (node._noteDockedComposer?.parentNode) node._noteDockedComposer.parentNode.removeChild(node._noteDockedComposer);
  node.el.classList.add("note-draft");
  let settled = false;
  function queueAssetCleanup(names, keepTracked) {
    names = Array.from(new Set(names || []));
    if (!names.length) return;
    if (!keepTracked)
      names.forEach(function (name) {
        uploadedNames.delete(name);
      });
    const cleanup = Promise.all(
      names.map(function (name) {
        return Promise.resolve(deleteAsset(name)).catch(function () {});
      }),
    );
    pendingAssetCleanup = Promise.allSettled([pendingAssetCleanup, cleanup]).then(function () {});
  }
  scope.addCleanup(function () {
    settled = true;
    queueAssetCleanup(Array.from(uploadedNames), true);
  });
  function release(restoreDockedComposer) {
    node._noteDraftDispose = null;
    scope.dispose();
    node._noteEditor = null;
    node._noteComposer = null;
    node._noteActions = null;
    node._noteInput = null;
    node._noteAttachmentStrip = null;
    node._noteAttachments = null;
    node._noteUploadedAssets = null;
    node._noteUploading = false;
    node._noteNormalizing = false;
    node._notePastePending = 0;
    if (restoreDockedComposer && node.el && node._noteDockedComposer) {
      node.el.insertBefore(node._noteDockedComposer, node.el.querySelector(".card-resize"));
    }
    node._noteDockedComposer = null;
    if (node.el) node.el.classList.remove("note-draft");
  }
  function discard() {
    if (settled || node._noteUploading) return;
    settled = true;
    release(false);
    teardownNode(node.id);
  }
  const submit = createStandaloneNoteSubmitter({
    node: node,
    editor: editor,
    attachments: attachments,
    uploadedNames: uploadedNames,
    scope: scope,
    active: function () {
      return !settled && !!node.el;
    },
    settle: function () {
      settled = true;
      release(true);
    },
    update: function () {
      updateStandaloneNoteComposer(node);
    },
    awaitAssetCleanup: function () {
      return pendingAssetCleanup;
    },
    queueAssetCleanup: queueAssetCleanup,
    fail: function (message) {
      flashHint(message);
      editor.focus({ preventScroll: true });
    },
  });
  function renderAttachments() {
    const keepEditorFocus = document.activeElement === editor;
    attachmentStrip.replaceChildren();
    attachmentStrip.hidden = attachments.length === 0;
    attachments.forEach(function (attachment, index) {
      const item = document.createElement("div");
      item.className = "paste-attachment";
      const image = document.createElement("img");
      image.src = attachment.previewUrl;
      image.alt = "Pasted image";
      image.draggable = false;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "paste-attachment-remove";
      remove.dataset.attachmentIndex = String(index);
      remove.setAttribute("aria-label", "Remove pasted image");
      remove.title = "Remove image";
      remove.textContent = "×";
      item.append(image, remove);
      attachmentStrip.appendChild(item);
    });
    growStandaloneNoteComposer(node);
    updateStandaloneNoteComposer(node);
    if (keepEditorFocus && editor.isConnected) editor.focus({ preventScroll: true });
  }
  scope.listen(attachmentStrip, "click", function (e) {
    const button = e.target.closest ? e.target.closest(".paste-attachment-remove") : null;
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    const index = Number(button.dataset.attachmentIndex);
    const removed = attachments.splice(index, 1)[0];
    if (removed) {
      releaseAttachment(removed);
      if (uploadedNames.has(removed.name)) queueAssetCleanup([removed.name], false);
    }
    renderAttachments();
    editor.focus({ preventScroll: true });
  });
  wirePastedImages({
    target: editor,
    listen: scope.listen,
    limit: MAX_ASK_ATTACHMENTS,
    count: function () {
      return attachments.length;
    },
    readFiles: clipboardImageFiles,
    normalize: normalizeClipboardImage,
    active: function () {
      return !settled && !!node.el;
    },
    accept: function (normalized) {
      attachments.push({ ...normalized, previewUrl: URL.createObjectURL(normalized.blob) });
    },
    onLimit: function () {
      flashHint(ATTACHMENT_LIMIT_MESSAGE);
    },
    onError: flashClipboardImageError,
    onPending: function (count) {
      node._notePastePending = count;
      node._noteNormalizing = count > 0;
      updateStandaloneNoteComposer(node);
    },
    onSettled: function () {
      if (!settled && node.el) renderAttachments();
    },
  });
  scope.listen(editor, "input", function () {
    growStandaloneNoteComposer(node);
    updateStandaloneNoteComposer(node);
  });
  scope.listen(editor, "keydown", function (e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    discard();
  });
  wireComposerActions({
    text: editor,
    actions: actions,
    listen: scope.listen,
    hasDraft: function () {
      return !!editor.value.trim() || attachments.length > 0;
    },
    commitFromEnter: noteCommitFromEnter,
    onCommit: function (kind, e) {
      e.stopPropagation();
      submit(kind === "note-window" ? "note" : kind);
    },
    onLens: function () {},
  });
  // Moving between the textarea and its actions stays inside one surface.
  // Once focus truly leaves, an empty draft vanishes and a written draft
  // keeps the established note-editor blur behavior by saving as Note.
  scope.listen(composer, "focusout", function () {
    function settleBlur() {
      if (settled || composer.contains(document.activeElement)) return;
      if (node._noteNormalizing) {
        scope.timeout(settleBlur, 25);
        return;
      }
      if (editor.value.trim() || attachments.length) submit("note");
      else discard();
    }
    scope.timeout(settleBlur, 0);
  });
  growStandaloneNoteComposer(node);
  updateStandaloneNoteComposer(node);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(editor.value.length, editor.value.length);
}
