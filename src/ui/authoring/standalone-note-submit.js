import { systemClock } from "../../core/clock.js";
import { BRANCH_FOLLOWUP } from "../../core/hole/ask.js";
import { truncate } from "../../core/hole/lens.js";
import { DEFAULT_STANDALONE_NOTE } from "../../core/layout.js";
import { ensureNodeMenuButton, fillBody, layoutNode, scheduleEdges, updateCardComposer } from "../canvas/index.js";
import { closed, deleteAsset, frozen, nodes, postBrowserEvent, putAsset, rootId, uuid } from "../core.js";
import { refreshNodeHtml } from "../renderer.js";

export function createStandaloneNoteSubmitter(context) {
  const { node, editor, attachments, uploadedNames } = context;
  return async function submit(kind) {
    if (!context.active() || node._noteUploading || node._noteNormalizing) return;
    const parent = nodes[rootId];
    if (closed || frozen) return;
    if (kind === "ask" && (!parent || parent.status === "pending" || parent.source?.converting)) return;
    const text = editor.value.trim();
    if (!text && !attachments.length) return;
    node._noteUploading = true;
    context.update();
    await context.awaitAssetCleanup();
    if (!context.active()) return;
    uploadedNames.clear();
    try {
      for (const attachment of attachments) {
        const response = await putAsset(attachment.name, attachment.blob);
        if (!context.active()) {
          if (response?.ok) Promise.resolve(deleteAsset(attachment.name)).catch(() => {});
          return;
        }
        if (!response?.ok) throw new Error("Asset upload failed");
        uploadedNames.add(attachment.name);
      }
    } catch (_error) {
      if (!context.active()) return;
      context.queueAssetCleanup([...uploadedNames], false);
      node._noteUploading = false;
      context.update();
      context.fail("Couldn't save those images — try again.");
      return;
    }
    if (!context.active()) return;
    const attachmentNames = attachments.map((attachment) => attachment.name);
    const committedHeight = Math.min(node.size.h, Math.max(DEFAULT_STANDALONE_NOTE.h, node.el.offsetHeight));
    if (kind === "ask") {
      const response = await Promise.resolve(
        postBrowserEvent({
          type: "branch_request",
          request_id: uuid(),
          node_id: node.id,
          parent_id: null,
          selected_text: "",
          question: text,
          lens: null,
          anchor: null,
          branch_type: BRANCH_FOLLOWUP,
          ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {}),
          position: { x: node.position.x, y: node.position.y },
          size: { w: node.size.w, h: committedHeight },
        }),
      ).catch(() => null);
      if (!context.active()) return;
      if (!response?.ok) {
        context.queueAssetCleanup([...uploadedNames], true);
        node._noteUploading = false;
        context.update();
        context.fail("Couldn't reach the agent — that ask wasn't posted.");
        return;
      }
      uploadedNames.clear();
      node.size.h = committedHeight;
      context.settle();
      node.title = truncate(text, 48) || "Pasted image";
      node.markdown = "";
      node.html = "";
      node.base_url = parent.base_url || null;
      node.base_url_source = parent.base_url ? "inherited" : null;
      node.read = false;
      node.origin = {
        selected_text: "",
        question: text,
        lens: null,
        anchor: null,
        branch_type: BRANCH_FOLLOWUP,
        ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {}),
      };
      node.status = "pending";
      node._startTs = systemClock.now();
      delete node._ephemeral;
      ensureNodeMenuButton(node);
      node.el.classList.remove("card-note");
      node.titleEl.textContent = node.title;
      node.titleEl.title = node.title;
      finishCanvasCommit(node, context);
      return;
    }
    const images = attachmentNames.map((name) => `![Pasted image](asset:${name})`);
    const markdown = [editor.value.trimEnd(), ...images].filter(Boolean).join("\n\n");
    const response = await Promise.resolve(
      postBrowserEvent({
        type: "node_create",
        id: node.id,
        parent_id: null,
        title: node.title,
        markdown,
        origin: node.origin,
        position: { x: node.position.x, y: node.position.y },
        size: { w: node.size.w, h: committedHeight },
      }),
    ).catch(() => null);
    if (!context.active()) return;
    if (!response?.ok) {
      context.queueAssetCleanup([...uploadedNames], true);
      node._noteUploading = false;
      context.update();
      context.fail("Couldn't save that note — try again.");
      return;
    }
    uploadedNames.clear();
    context.settle();
    node.markdown = markdown;
    node.size.h = committedHeight;
    delete node._ephemeral;
    ensureNodeMenuButton(node);
    finishCanvasCommit(node, context);
  };
}

function finishCanvasCommit(node, context) {
  refreshNodeHtml(node);
  fillBody(node);
  layoutNode(node);
  updateCardComposer(node);
  scheduleEdges();
}
