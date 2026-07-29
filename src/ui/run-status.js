import { iconSvg } from "../core/html/icons.js";
import { openDialog } from "./primitives/dialog.js";

var runSummaries = new Map();
var detailsHandle = null;

export function disposeRunStatus(){
  if (detailsHandle) {
    detailsHandle.dispose({ restoreFocus: false });
    detailsHandle = null;
  }
  runSummaries = new Map();
}

export function setRunStatusHydration(hydration){
  runSummaries = new Map();
  var runs = hydration?.nora?.runs;
  if (!Array.isArray(runs)) return;
  runs.forEach(function(run){
    if (run && typeof run.id === "string" && run.id) runSummaries.set(run.id, run);
  });
}

export function runStateOf(node){
  var state = String(node?.nora_state || "");
  if (state) return state;
  return node?.status === "pending" ? "running" : "complete";
}

export function isLiveRunState(node){
  var state = runStateOf(node);
  return state === "pending" || state === "running";
}

export function isTerminalRunState(node){
  var state = runStateOf(node);
  return state === "cancelled" || state === "failed" || state === "interrupted";
}

export function runStatusLabel(state){
  if (state === "pending") return "Queued";
  if (state === "running") return "Running";
  if (state === "cancelled") return "Cancelled";
  if (state === "failed") return "Failed";
  if (state === "interrupted") return "Interrupted";
  return "Complete";
}

export function buildRunStateNotice(node){
  var state = runStateOf(node);
  if (state === "complete") return null;
  var notice = document.createElement("div");
  notice.className = "run-state-notice run-state-" + state;
  notice.setAttribute("role", state === "running" || state === "pending" ? "status" : "note");
  notice.setAttribute("aria-label", "Run state: " + runStatusLabel(state));
  var label = document.createElement("span");
  label.className = "run-state-label";
  label.textContent = runStatusLabel(state);
  var detail = document.createElement("span");
  detail.className = "run-state-detail";
  detail.textContent = runStateDetail(node, state);
  notice.append(label, detail);
  return notice;
}

export function buildRunDetailsButton(node, options){
  if (!node || !node.run_id) return null;
  var button = document.createElement("button");
  button.type = "button";
  button.className = (options && options.className) || "run-details-button";
  button.innerHTML = iconSvg("info") + "<span>Run Details</span>";
  button.title = "Open run details";
  button.setAttribute("aria-label", "Open run details");
  button.addEventListener("click", function(event){
    event.preventDefault();
    event.stopPropagation();
    openRunDetails(node, button);
  });
  return button;
}

export function openRunDetails(node, trigger){
  var backdrop = document.getElementById("run-details-backdrop");
  var dialog = document.getElementById("run-details");
  if (!backdrop || !dialog || !node?.run_id) return;
  if (detailsHandle) detailsHandle.dispose({ restoreFocus: false });
  renderRunDetails(dialog, node);
  var close = dialog.querySelector("[data-run-details-close]");
  detailsHandle = openDialog({
    dialog: dialog,
    backdrop: backdrop,
    trigger: trigger || null,
    labelledby: "run-details-title",
    initialFocus: close,
    closeOnBackdrop: true,
    onClose: function(){ detailsHandle = null; }
  });
  close?.addEventListener("click", function(){ if (detailsHandle) detailsHandle.close("button"); }, { once: true });
}

function renderRunDetails(dialog, node){
  var run = runSummaries.get(node.run_id) || {};
  setText(dialog, "[data-run-details-node]", node.title || "Untitled");
  setText(dialog, "[data-run-details-status]", runStatusLabel(String(run.status || runStateOf(node))));
  setText(dialog, "[data-run-details-profile]", compact([run.profileId, run.provider, run.model].filter(Boolean).join(" / ")) || "Profile unavailable");
  setText(dialog, "[data-run-details-endpoint]", compact(run.endpoint || "") || "Endpoint unavailable");
  setText(dialog, "[data-run-details-prompt]", compact(run.prompt || node.origin?.question || "") || "No prompt recorded yet.");
  renderTrace(dialog.querySelector("[data-run-details-trace]"), traceEntries(run));
}

function renderTrace(container, entries){
  if (!container) return;
  container.innerHTML = "";
  if (!entries.length) {
    var empty = document.createElement("div");
    empty.className = "run-trace-empty";
    empty.textContent = "No transcript records are available in this migration slice.";
    container.appendChild(empty);
    return;
  }
  entries.forEach(function(entry){
    var item = document.createElement("div");
    item.className = "run-trace-entry";
    var kind = document.createElement("div");
    kind.className = "run-trace-kind";
    kind.textContent = String(entry.kind || entry.role || entry.type || "record");
    var text = document.createElement("pre");
    text.textContent = compact(entry.text || entry.content || entry.summary || JSON.stringify(entry, null, 2));
    item.append(kind, text);
    container.appendChild(item);
  });
}

function traceEntries(run){
  var candidates = [
    run.messages,
    run.transcript,
    run.events,
    run.extensions?.messages,
    run.extensions?.transcript,
    run.extensions?.trace,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (Array.isArray(candidates[i])) return candidates[i];
  }
  return [];
}

function runStateDetail(node, state){
  if (state === "pending") return "Nora has queued this request.";
  if (state === "running") return node?.md ? "Nora is still writing. Partial content remains selectable." : "Nora is preparing this result.";
  if (state === "cancelled") return "This run was cancelled. Partial content is kept.";
  if (state === "failed") return "This run failed. Any partial content is kept.";
  if (state === "interrupted") return "This run was interrupted before Nora could finish it.";
  return "";
}

function setText(root, selector, text){
  var element = root.querySelector(selector);
  if (element) element.textContent = text;
}

function compact(value){
  return String(value || "").replace(/\s+/g, " ").trim();
}
