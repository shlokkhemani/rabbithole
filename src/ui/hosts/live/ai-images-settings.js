import { aiImagesEnabled, onPreferenceChange, setAiImagesEnabled } from "../../preferences.js";
import { registerSettingsSection } from "../../settings-sheet.js";

export const AI_IMAGES_SETTINGS_SUBTITLE =
  "Your agent can draw a picture when you ask for one, using Codex image generation. Each picture costs extra tokens, so this is off by default. Needs Codex installed and signed in.";

function mountAiImagesSettings(host) {
  host.innerHTML = `
    <div class="settings-sheet-section">
      <div class="settings-sheet-row" id="settings-ai-images-row">
        <div class="settings-sheet-copy">
          <span class="settings-sheet-label" id="settings-ai-images-label">AI images</span>
          <small class="settings-sheet-sub">${AI_IMAGES_SETTINGS_SUBTITLE}</small>
        </div>
        <div class="settings-sheet-control">
          <span class="switch">
            <input type="checkbox" role="switch" data-ai-images-enabled aria-labelledby="settings-ai-images-label">
            <span class="switch-track"></span>
          </span>
        </div>
      </div>
    </div>`;
  const enabled = host.querySelector("[data-ai-images-enabled]");

  function sync() {
    enabled.checked = aiImagesEnabled();
  }

  enabled.addEventListener("change", function () {
    setAiImagesEnabled(enabled.checked);
  });
  const stopListening = onPreferenceChange(function (kind) {
    if (kind === "ai-images") sync();
  });
  sync();
  return stopListening;
}

export function registerAiImagesSettings() {
  registerSettingsSection({ id: "ai-images", label: "Images", order: 7, mount: mountAiImagesSettings });
}
