import { DEFAULT_ASK_PRESET_KEYS, DEFAULT_ASK_PRESETS } from "../core/hole/lens.js";
import { DEFAULT_REACTION_PROMPTS, REACTION_KEYS } from "../core/hole/reaction.js";
import { buttonMarkup } from "../core/html/markup.js";
import { escapeHtml } from "../core/utils.js";
import { createCleanupScope } from "./kit/scope.js";
import { registerLayer } from "./overlay/layer-stack.js";
import {
  askPreset,
  askPresets,
  askPresetsLinked,
  createCustomAskPreset,
  reactionPrompt,
  reactionPrompts,
  resetAskPreset,
  resetReactionPrompt,
  setAskPreset,
  setAskPresetRemoved,
  setAskPresetsLinked,
  setReactionPrompt,
  visibleAskPresetKeys,
} from "./preferences.js";

// One text node keeps mirrorLabel's live preview a single nodeValue write.
function presetPillText(preset) {
  return `${preset.label} `;
}

/** Fill one composer action group from the user's local preset set. */
export function renderAskPresetActions(actions, set) {
  if (!actions) return;
  const setKey = set === "selection" ? "selection" : "followup";
  const group = actions.querySelector(".preset-actions");
  if (!group) return;
  const disabled = !!group.querySelector(".lens:disabled");
  group.dataset.presetSet = setKey;
  const keys = visibleAskPresetKeys(setKey);
  // With every preset removed the surface rests as a bare input; CSS hides the
  // empty row until a draft brings the commit pair back.
  actions.classList.toggle("no-presets", keys.length === 0);
  group.innerHTML = keys
    .map((key, index) => {
      const preset = askPreset(setKey, key) || DEFAULT_ASK_PRESETS[setKey][key];
      return buttonMarkup({
        bare: true,
        className: "lens ask-preset",
        dataAttrs: { lens: key },
        label: presetPillText(preset),
        title: preset.instruction,
        kbdHint: String(index + 1),
        disabled,
      });
    })
    .join("");
}

export function refreshAskPresetActions(root = document) {
  root.querySelectorAll(".preset-actions[data-preset-set]").forEach((group) => {
    const element = /** @type {HTMLElement} */ (group);
    renderAskPresetActions(element.closest(".ask-actions"), element.dataset.presetSet);
  });
}

export function presetFor(set, key) {
  return askPreset(set, key);
}

export function presetLabelForOrigin(origin) {
  if (!origin?.lens) return "";
  const set = origin.branch_type === "selection" ? "selection" : "followup";
  return askPreset(set, origin.lens)?.label || String(origin.lens);
}

export function displayQuestionForOrigin(origin) {
  return String(origin?.question || "").trim() || presetLabelForOrigin(origin);
}

/*
 * The Quick questions section is the product wearing its own clothes: each
 * preset set renders inside a faithful, full-width replica of its real surface
 * — the selection popover's glass and shadow, the reader composer's card —
 * built from the real .ask-input/.ask-actions parts so spacing and washes can
 * never drift from the product. Clicking a pill expands its editor in place
 * beneath the row. One editor is open at a time; the open editor joins the
 * overlay stack so Escape gives back one level (editor, then sheet) and a
 * click elsewhere collapses it without swallowing that click. Ticking the
 * link collapses the follow-up surface entirely — its own set is kept, not
 * overwritten, so unticking restores it exactly.
 */

const SURFACE_COPY = Object.freeze({
  selection: {
    title: "When you select something",
    group: "Selection presets",
  },
  followup: {
    title: "When you follow up",
    group: "Follow-up presets",
  },
});

function samePreset(a, b) {
  return a?.label === b?.label && a?.instruction === b?.instruction;
}

function mockPresetButton(set, key, index) {
  const preset = askPreset(set, key);
  return buttonMarkup({
    bare: true,
    className: "lens",
    dataAttrs: { presetButton: key },
    label: presetPillText(preset),
    title: preset.instruction,
    kbdHint: String(index + 1),
    ariaExpanded: "false",
  });
}

const REACTION_COPY = Object.freeze({ up: "Thumbs up", down: "Thumbs down" });
const REACTION_HINT = Object.freeze({ up: "↑", down: "↓" });

// The thumbs are fixed chrome on the selection surface — the replica wears
// them in the same trailing slot, and clicking one edits its instruction the
// way clicking a pill edits the pill. The glyph is not editable; only the words
// behind it are.
function mockReactionButton(key) {
  return buttonMarkup({
    bare: true,
    className: "thumb",
    dataAttrs: { reactionButton: key },
    label: `${DEFAULT_REACTION_PROMPTS[key].glyph} `,
    ariaLabel: REACTION_COPY[key],
    title: reactionPrompt(key).instruction,
    kbdHint: REACTION_HINT[key],
    ariaExpanded: "false",
  });
}

function surfaceMarkup(set) {
  const copy = SURFACE_COPY[set];
  const thumbs =
    set === "selection" ? `<span class="thumb-pair">${REACTION_KEYS.map(mockReactionButton).join("")}</span>` : "";
  return `<section class="asking-surface" data-asking-surface data-set="${set}">
    <header><h4>${copy.title}</h4></header>
    <div class="asking-mock ${set === "selection" ? "asking-mock-popover" : "asking-mock-composer"}">
      <div class="ask-input"><div class="asking-ghost" aria-hidden="true">Ask or note…</div></div>
      <div class="ask-actions" role="group" aria-label="${copy.group}"><div class="preset-actions" data-asking-actions></div>${thumbs}</div>
      <div class="asking-editor" data-asking-editor><div class="asking-editor-body" data-asking-editor-body></div></div>
    </div>
    <p class="asking-removed" data-asking-removed hidden></p>
  </section>`;
}

function editorMarkup(set, key) {
  const preset = askPreset(set, key);
  const defaults = DEFAULT_ASK_PRESETS[set][key];
  const prefix = `asking-${set}-${key}`;
  return `<div class="asking-editor-fields">
    <label for="${prefix}-label">Label</label>
    <input id="${prefix}-label" name="${prefix}-label" type="text" autocomplete="off" spellcheck="false" data-preset-label maxlength="80" value="${escapeHtml(preset.label)}">
    <label for="${prefix}-instruction">Instruction</label>
    <textarea id="${prefix}-instruction" name="${prefix}-instruction" autocomplete="off" data-preset-instruction rows="2" maxlength="4000">${escapeHtml(preset.instruction)}</textarea>
    <div class="asking-editor-foot">
      ${buttonMarkup({
        bare: true,
        className: "asking-preset-remove",
        dataAttrs: { presetRemove: true },
        label: "Remove",
        title:
          key === "custom"
            ? `Remove “${preset.label}”`
            : `Take “${preset.label}” off this row — bring it back any time`,
      })}
      ${
        defaults
          ? buttonMarkup({
              bare: true,
              className: "asking-preset-reset",
              dataAttrs: { presetReset: true },
              label: "Reset to default",
              title: `Back to the built-in “${defaults.label}” question`,
              hidden: samePreset(preset, defaults),
            })
          : ""
      }
      ${buttonMarkup({
        bare: true,
        className: "asking-preset-done",
        dataAttrs: { presetDone: true },
        label: "Done",
        title: "Close the editor — changes save as you type",
      })}
    </div>
  </div>`;
}

// A reaction has no label to edit and nothing to remove: Instruction, Reset, Done.
function reactionEditorMarkup(key) {
  const prompt = reactionPrompt(key);
  const prefix = `asking-reaction-${key}`;
  return `<div class="asking-editor-fields" data-reaction-prompt="${key}">
    <label for="${prefix}-instruction">Instruction</label>
    <textarea id="${prefix}-instruction" name="${prefix}-instruction" autocomplete="off" data-reaction-instruction rows="2" maxlength="4000" aria-label="Instruction for ${REACTION_COPY[key].toLowerCase()}">${escapeHtml(prompt.instruction)}</textarea>
    <div class="asking-editor-foot">
      ${buttonMarkup({
        bare: true,
        className: "asking-preset-reset",
        dataAttrs: { reactionReset: true },
        label: "Reset to default",
        title: `Restore the default ${REACTION_COPY[key].toLowerCase()} instruction`,
        hidden: prompt.instruction === DEFAULT_REACTION_PROMPTS[key].instruction,
      })}
      ${buttonMarkup({
        bare: true,
        className: "asking-preset-done",
        dataAttrs: { presetDone: true },
        label: "Done",
        title: "Close the editor — changes save as you type",
      })}
    </div>
  </div>`;
}

function askingMarkup() {
  return `<div class="settings-sheet-section asking-settings">
    ${surfaceMarkup("selection")}
    <label class="settings-sheet-row asking-link">
      <span class="settings-sheet-copy">
        <span class="settings-sheet-label">Follow-ups ask the same questions</span>
        <span class="settings-sheet-sub">One set everywhere. Turn off to give follow-ups their own.</span>
      </span>
      <span class="switch">
        <input type="checkbox" role="switch" data-asking-link>
        <span class="switch-track"></span>
      </span>
    </label>
    <div class="asking-reveal" data-asking-reveal>
      <div class="asking-reveal-body">
        ${surfaceMarkup("followup")}
      </div>
    </div>
  </div>`;
}

export function mountAskingSettings(host) {
  host.innerHTML = askingMarkup();
  const scope = createCleanupScope();
  const link = /** @type {HTMLInputElement} */ (host.querySelector("[data-asking-link]"));
  const reveal = /** @type {HTMLElement} */ (host.querySelector("[data-asking-reveal]"));
  const surfaces = {};
  host.querySelectorAll("[data-asking-surface]").forEach((root) => {
    surfaces[root.dataset.set] = {
      set: root.dataset.set,
      row: root.querySelector(".ask-actions"),
      group: root.querySelector("[data-asking-actions]"),
      editor: root.querySelector("[data-asking-editor]"),
      body: root.querySelector("[data-asking-editor-body]"),
      removed: root.querySelector("[data-asking-removed]"),
    };
  });

  /**
   * One editor at a time, for a preset pill or a reaction thumb. Reactions only
   * live on the selection surface; their key is "up" | "down".
   * @type {{ set: string, key: string, kind: "preset" | "reaction", unregister: (settings?: any) => void } | null}
   */
  let active = null;

  const buttonOf = (set, key, kind = "preset") =>
    kind === "reaction"
      ? surfaces[set].row.querySelector(`[data-reaction-button="${key}"]`)
      : surfaces[set].group.querySelector(`[data-preset-button="${key}"]`);

  function renderActions(set) {
    const surface = surfaces[set];
    const keys = visibleAskPresetKeys(set);
    const addSlot = keys.length < 3;
    surface.row.classList.remove("no-presets");
    // Add question occupies the same vacant slot a custom question will fill.
    surface.group.innerHTML =
      keys.map((key, index) => mockPresetButton(set, key, index)).join("") +
      (addSlot
        ? buttonMarkup({
            bare: true,
            className: "lens asking-add",
            dataAttrs: { presetAdd: true },
            label: "Add question",
            title: "Add a quick question",
          })
        : "");
  }

  function renderRemoved(set) {
    const surface = surfaces[set];
    const removed = DEFAULT_ASK_PRESET_KEYS.filter((key) => askPreset(set, key)?.removed === true);
    surface.removed.hidden = removed.length === 0;
    surface.removed.innerHTML = removed.length
      ? `<span class="asking-removed-label">Removed:</span>` +
        removed
          .map((key) =>
            buttonMarkup({
              bare: true,
              className: "asking-restore",
              dataAttrs: { presetRestore: key },
              label: askPreset(set, key).label,
              title: `Bring “${askPreset(set, key).label}” back`,
            }),
          )
          .join("")
      : "";
  }

  function closeEditor(options) {
    if (!active) return;
    const { set, key, kind, unregister } = active;
    active = null;
    unregister({ restoreFocus: false });
    const surface = surfaces[set];
    surface.editor.classList.remove("open");
    const button = buttonOf(set, key, kind);
    if (button) {
      button.classList.remove("editing");
      button.setAttribute("aria-expanded", "false");
      if (options?.focusButton) button.focus();
    }
  }

  function syncReset() {
    if (!active) return;
    const body = surfaces[active.set].body;
    if (active.kind === "reaction") {
      const reset = body.querySelector("[data-reaction-reset]");
      if (reset)
        reset.hidden = reactionPrompt(active.key).instruction === DEFAULT_REACTION_PROMPTS[active.key].instruction;
      return;
    }
    const reset = body.querySelector("[data-preset-reset]");
    const defaults = DEFAULT_ASK_PRESETS[active.set][active.key];
    if (reset && defaults) reset.hidden = samePreset(askPreset(active.set, active.key), defaults);
  }

  // The pill is the preview: its label and tooltip track the stored value live.
  // A thumb's glyph never changes, so only its tooltip follows the instruction.
  function mirrorLabel(set, key, kind = "preset") {
    const button = buttonOf(set, key, kind);
    if (!button) return;
    if (kind === "reaction") {
      button.title = reactionPrompt(key).instruction;
      return;
    }
    const saved = askPreset(set, key);
    if (button.firstChild) button.firstChild.nodeValue = presetPillText(saved);
    button.title = saved.instruction;
  }

  /** @param {string} set @param {string} key @param {"preset" | "reaction"} [kind] */
  function openEditor(set, key, kind = "preset") {
    closeEditor();
    const surface = surfaces[set];
    surface.body.innerHTML = kind === "reaction" ? reactionEditorMarkup(key) : editorMarkup(set, key);
    const button = buttonOf(set, key, kind);
    const unregister = registerLayer({
      element: surface.editor,
      trigger: button,
      preventOutsidePointerDefault: false,
      restoreFocus: false,
      onClose: (reason) => closeEditor({ focusButton: reason === "escape" }),
    });
    active = { set, key, kind, unregister };
    surface.editor.classList.add("open");
    button.classList.add("editing");
    button.setAttribute("aria-expanded", "true");
    surface.body.querySelector(kind === "reaction" ? "[data-reaction-instruction]" : "[data-preset-label]")?.focus();
  }

  Object.values(surfaces).forEach((surface) => {
    scope.listen(surface.row, "click", (event) => {
      const button = /** @type {HTMLButtonElement | null} */ (
        /** @type {Element} */ (event.target).closest?.(
          "[data-preset-button], [data-preset-add], [data-reaction-button]",
        )
      );
      if (!button) return;
      if (button.hasAttribute("data-reaction-button")) {
        const key = button.dataset.reactionButton;
        if (active && active.set === surface.set && active.kind === "reaction" && active.key === key) {
          closeEditor({ focusButton: true });
        } else openEditor(surface.set, key, "reaction");
        return;
      }
      if (button.hasAttribute("data-preset-add")) {
        createCustomAskPreset(surface.set);
        renderActions(surface.set);
        renderRemoved(surface.set);
        openEditor(surface.set, "custom");
        const label = /** @type {HTMLInputElement | null} */ (surface.body.querySelector("[data-preset-label]"));
        label?.select();
        return;
      }
      const key = button.dataset.presetButton;
      if (active && active.set === surface.set && active.kind === "preset" && active.key === key) {
        closeEditor({ focusButton: true });
      } else openEditor(surface.set, key);
    });
    scope.listen(surface.body, "input", (event) => {
      if (!active || active.set !== surface.set) return;
      const field = /** @type {HTMLTextAreaElement} */ (event.target);
      if (active.kind === "reaction") {
        if (!field.matches?.("[data-reaction-instruction]")) return;
        setReactionPrompt(active.key, { instruction: field.value });
        mirrorLabel(active.set, active.key, "reaction");
        syncReset();
        return;
      }
      if (!field.matches?.("[data-preset-label], [data-preset-instruction]")) return;
      const label = surface.body.querySelector("[data-preset-label]");
      const instruction = surface.body.querySelector("[data-preset-instruction]");
      setAskPreset(active.set, active.key, { label: label.value, instruction: instruction.value });
      mirrorLabel(active.set, active.key);
      syncReset();
    });
    scope.listen(surface.body, "focusout", (event) => {
      if (!active || active.set !== surface.set) return;
      const field = /** @type {HTMLInputElement} */ (event.target);
      if (active.kind === "reaction") {
        if (field.matches?.("[data-reaction-instruction]")) field.value = reactionPrompt(active.key).instruction;
        return;
      }
      if (!field.matches?.("[data-preset-label], [data-preset-instruction]")) return;
      const saved = askPreset(active.set, active.key);
      field.value = field.matches("[data-preset-label]") ? saved.label : saved.instruction;
    });
    scope.listen(surface.body, "keydown", (event) => {
      if (!active || active.set !== surface.set) return;
      const keyEvent = /** @type {KeyboardEvent} */ (event);
      if (keyEvent.key !== "Enter") return;
      if (!(/** @type {Element} */ (event.target).matches?.("[data-preset-label]"))) return;
      keyEvent.preventDefault();
      closeEditor({ focusButton: true });
    });
    scope.listen(surface.body, "click", (event) => {
      if (!active || active.set !== surface.set) return;
      const target = /** @type {Element} */ (event.target);
      if (target.closest?.("[data-preset-done]")) {
        closeEditor({ focusButton: true });
        return;
      }
      if (target.closest?.("[data-reaction-reset]")) {
        const field = /** @type {HTMLTextAreaElement} */ (surface.body.querySelector("[data-reaction-instruction]"));
        field.value = resetReactionPrompt(active.key).instruction;
        mirrorLabel(active.set, active.key, "reaction");
        syncReset();
        field.focus();
        return;
      }
      if (target.closest?.("[data-preset-reset]")) {
        const next = resetAskPreset(active.set, active.key);
        surface.body.querySelector("[data-preset-label]").value = next.label;
        surface.body.querySelector("[data-preset-instruction]").value = next.instruction;
        mirrorLabel(active.set, active.key);
        syncReset();
        return;
      }
      if (target.closest?.("[data-preset-remove]")) {
        const key = active.key;
        closeEditor();
        setAskPresetRemoved(surface.set, key, true);
        renderActions(surface.set);
        renderRemoved(surface.set);
        // Continuity for keyboard users: focus lands on the way back in.
        if (key === "custom") surface.group.querySelector("[data-preset-add]")?.focus();
        else surface.removed.querySelector(`[data-preset-restore="${key}"]`)?.focus();
      }
    });
    scope.listen(surface.removed, "click", (event) => {
      const chip = /** @type {HTMLElement | null} */ (
        /** @type {Element} */ (event.target).closest?.("[data-preset-restore]")
      );
      if (!chip) return;
      const key = chip.dataset.presetRestore;
      setAskPresetRemoved(surface.set, key, false);
      renderActions(surface.set);
      renderRemoved(surface.set);
      buttonOf(surface.set, key)?.focus();
    });
  });

  link.checked = askPresetsLinked();
  reveal.classList.toggle("collapsed", link.checked);
  scope.listen(link, "change", () => {
    if (active && active.set === "followup") closeEditor();
    setAskPresetsLinked(link.checked);
    reveal.classList.toggle("collapsed", link.checked);
    if (!link.checked) {
      // The follow-up set was kept, not overwritten — re-render its own truth.
      renderActions("followup");
      renderRemoved("followup");
    }
  });

  renderActions("selection");
  renderRemoved("selection");
  renderActions("followup");
  renderRemoved("followup");

  return () => {
    closeEditor();
    scope.dispose();
  };
}

export function askingSettingsSection() {
  // Touch storage at the section boundary so legacy shapes migrate before UI.
  askPresets();
  reactionPrompts();
  return { id: "asking", label: "Quick questions", order: 5, mount: mountAskingSettings };
}
