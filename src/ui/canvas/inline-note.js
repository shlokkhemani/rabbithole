import { extractNodeAssetRefs } from "../../core/assets.js";
import { ATTACHMENT_LIMIT_MESSAGE, MAX_ASK_ATTACHMENTS } from "../../core/attachments.js";
import { isNoteNode } from "../../core/hole/ask.js";
import { wirePastedImages } from "../authoring/note-editor.js";
import { normalizeClipboardImage } from "../clipboard-image.js";
import { wireComposerActions } from "../composer-state.js";
import { closed, deleteAsset, flashHint, frozen, putAsset } from "../core.js";
import { createCleanupScope } from "../kit/scope.js";
import { refreshNodeHtml, registerRendererAssetName } from "../renderer.js";
import { structuredNoteController } from "../structured-note.js";
import { noteCommitFromEnter, noteComposerActions } from "./document.js";
import { scheduleEdges } from "./edges.js";
import { layoutNode } from "./gestures.js";
import { canConvertNote } from "./menu.js";
import { convertNoteToAsk } from "./note-convert.js";
import { r } from "./runtime.js";
import { clipboardImageFiles, flashClipboardImageError } from "./shared.js";
import { startStandaloneNoteComposer } from "./standalone-note.js";

export function startNoteEditing(node, dc, caretOffset, pointer) {
  if (!isNoteNode(node) || frozen || closed || node._noteEditor) return;
  if (node._ephemeral) {
    startStandaloneNoteComposer(node, dc);
    return;
  }
  const controller = structuredNoteController(dc);
  if (!controller) return;
  const original = node.markdown || "";
  let markdown = original;
  const editScope = createCleanupScope();
  const listen = editScope.listen;
  editScope.addCleanup(function () {
    controller.setOnChange(null);
  });
  const actions = noteComposerActions();
  const convertible = canConvertNote(node);
  if (!convertible) {
    actions.querySelector('[data-commit="ask"]').remove();
    actions.classList.add("note-only");
  }
  actions.classList.add("note-edit-actions", "has-draft");
  node.bodyEl.appendChild(actions);
  node.el.classList.add("note-editing");
  node._noteEditor = dc;
  node._noteEditSurface = node.bodyEl;
  let settled = false;
  let settling = false;
  const uploadedNames = new Set();
  let pasteQueue = null;
  function updateActions() {
    const disabled = settling || !markdown.trim();
    /** @type {NodeListOf<HTMLButtonElement>} */
    const commits = actions.querySelectorAll(".ask-commit");
    for (let i = 0; i < commits.length; i++) commits[i].disabled = disabled;
  }
  function stopEditing() {
    if (node._noteEditDispose) node._noteEditDispose();
    controller.setOnChange(null);
    controller.setEditable(false);
    actions.remove();
    node.el.classList.remove("note-editing");
    node._noteEditor = null;
    node._noteEditSurface = null;
    node._noteEditDispose = null;
    layoutNode(node);
    scheduleEdges();
  }
  async function finish(kind) {
    if (settled || settling) return;
    settling = true;
    updateActions();
    await pasteQueue.settle();
    const referenced = kind === "cancel" ? new Set() : extractNodeAssetRefs({ markdown: markdown });
    const cleanup = Array.from(uploadedNames).filter(function (name) {
      return !referenced.has(name);
    });
    await Promise.allSettled(
      cleanup.map(function (name) {
        return Promise.resolve(deleteAsset(name));
      }),
    );
    settled = true;
    if (kind === "cancel") {
      controller.replaceMarkdown(original);
      stopEditing();
      return;
    }
    if (!markdown.trim()) {
      controller.replaceMarkdown(original);
      stopEditing();
      return;
    }
    stopEditing();
    if (kind === "ask" && convertNoteToAsk(node, markdown)) return;
    node.markdown = markdown;
    refreshNodeHtml(node);
    document.querySelectorAll('.doc-content[data-node-id="' + node.id + '"]').forEach(function (other) {
      if (other === dc) return;
      const otherController = structuredNoteController(other);
      if (otherController) otherController.replaceMarkdown(markdown);
    });
    r.lifecycle.hooks.persistNode(node);
  }
  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish("cancel");
    }
  }
  pasteQueue = wirePastedImages({
    target: dc,
    listen: listen,
    limit: MAX_ASK_ATTACHMENTS,
    count: function () {
      return uploadedNames.size;
    },
    readFiles: clipboardImageFiles,
    normalize: normalizeClipboardImage,
    active: function () {
      return !settled && !settling;
    },
    accept: async function (normalized) {
      const response = await putAsset(normalized.name, normalized.blob);
      if (!response || !response.ok) throw new Error("Asset upload failed");
      uploadedNames.add(normalized.name);
      registerRendererAssetName(normalized.name);
      controller.insertImage("asset:" + normalized.name, "Pasted image");
      updateActions();
    },
    onLimit: function () {
      flashHint(ATTACHMENT_LIMIT_MESSAGE);
    },
    onError: function (error) {
      if (error?.code) flashClipboardImageError(error);
      else flashHint("Couldn't save that image — try again.");
    },
  });
  listen(dc, "keydown", onKeyDown);
  listen(actions, "pointerdown", function (e) {
    if (e.target.closest && e.target.closest("button")) e.preventDefault();
  });
  wireComposerActions({
    text: dc,
    actions: actions,
    listen: listen,
    hasDraft: function () {
      return !!markdown.trim();
    },
    commitFromEnter: noteCommitFromEnter,
    onCommit: function (kind, e) {
      e.stopPropagation();
      finish(kind === "note-window" ? "note" : kind);
    },
    onLens: function () {},
  });
  function onFocusOut() {
    setTimeout(function () {
      if (!settled && !dc.contains(document.activeElement) && !actions.contains(document.activeElement)) finish("note");
    }, 0);
  }
  listen(dc, "focusout", onFocusOut);
  listen(actions, "focusout", onFocusOut);
  node._noteEditDispose = function () {
    editScope.dispose();
  };
  controller.setOnChange(function (next) {
    markdown = next;
    updateActions();
  });
  updateActions();
  if (pointer) controller.focusAtCoords(pointer.left, pointer.top);
  else controller.focusAt(caretOffset);
}
