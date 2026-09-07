# SPEC: AI images behind a setting

Companion to SPEC-IMAGES.md. Image generation (`generate_image`) becomes opt-in. Off is the default and means the MCP server behaves exactly as it did before images shipped: no tool, no guidance, no instruction sentence, zero extra tokens. On restores today's behaviour. The switch applies live to the connected agent.

## 1. Why

Measured on real sessions (2026-09-07): image support costs every session about 500 tokens of tool descriptions, and each generated image costs the answering thread about 2,300 input tokens once plus the same again as a cache read on every later turn. A normal `answer_branch` result costs about 175. Users who never draw should not pay any of it.

## 2. Decisions (locked with the user)

- Default OFF.
- One global switch in the settings sheet, host app only. Never rendered on rabbithole.ing. Persisted in `~/.rabbithole/preferences.json` through the existing prefs store.
- Flipping the switch applies live to the running MCP session. Tools list and `answer_branch` description update through `notifications/tools/list_changed`.
- OFF gates discovery and authoring only. Existing generated images, their assets, `generated_images` provenance, the lightbox caption, and the "Drawing…" state keep working untouched.
- Downscaling the image copy sent back to the model is a separate, later change. Not part of this spec.

## 3. Preference

- Key `rh-ai-images`. Value `"on"` means enabled. Any other value or absence means off. Turning off deletes the key (`null` in the patch), matching `rh-auto-tidy` (`src/ui/preferences.js:277-288`).
- Browser-safe accessors in `src/ui/preferences.js`: `aiImagesEnabled()`, `setAiImagesEnabled(next)`, change-listener key `"ai-images"` through the existing `onPreferenceChange` registry. Follow the auto-tidy cache pattern exactly.
- Node-side interpretation in a new `src/node/mcp/images-setting.js`:
  - `export const AI_IMAGES_PREF_KEY = "rh-ai-images"`
  - `export function imagesEnabled(values)` → `values?.[AI_IMAGES_PREF_KEY] === "on"`
  - `export async function readImagesEnabled()` → `imagesEnabled(await readPreferences())`
  The UI must not import this module (purity), so the key string is duplicated in `src/ui/preferences.js`; a unit test pins that both constants are equal by importing each.

## 4. Prefs store: merge notification seam

`src/node/mcp/store/prefs-store.js` gains

```js
export function onPreferencesMerged(listener) // returns unsubscribe
```

`mergeLocked` calls every listener with the applied patch object (the raw `{key: string|null}` values it just wrote) after the atomic rename succeeds. Listener exceptions are caught and logged with `warn`; they never reject the merge and never turn a successful browser POST into an HTTP failure. Listeners run in registration order, synchronously after the write, before `mergePreferences` resolves.

## 5. MCP server: build from the pref, then follow it live

### 5.1 Descriptions and instructions become builders

- `src/node/mcp/tools.js`: export `answerBranchDescription({ imagesEnabled })`. It returns the current joined description when `imagesEnabled` is true and the same text without the `GENERATE_IMAGE_GUIDANCE_V1` block (and its preceding blank line) when false. The static `toolDefinitions` array keeps the full variant as `answer_branch.description` and keeps `generate_image` in the array, so `scripts/build-docs.mjs` and the existing contracts still see the complete manifest.
- `src/node/mcp/instructions.js`: export `buildServerInstructions({ imagesEnabled })`. The `generate_image` sentence (currently line 10) is included only when true. Keep `SERVER_INSTRUCTIONS` exported as the full variant so existing imports and the copy budget keep working.

### 5.2 main.js composition moves into async startup

`src/node/mcp/main.js` currently constructs `McpServer` at module scope (`main.js:13-17`) and registers tools in a loop discarding the `RegisteredTool` handles (`main.js:24-39`). Change to:

1. `main()` reads `const enabled = await readImagesEnabled()` before constructing the server. If the preferences file is unreadable the store already returns empty values, which means off. Fail closed.
2. Construct `McpServer` with `instructions: buildServerInstructions({ imagesEnabled: enabled })`. Instructions are delivered once at initialize and cannot change live. Accept that; the tool list and description are what the model reads per call.
3. Register every tool as today but keep the handles in a `Map`. Immediately after registration, and before `connect`, apply the state: when off, `handles.get("generate_image").disable()` and `handles.get("answer_branch").update({ description: answerBranchDescription({ imagesEnabled: false }) })`. Before connect the SDK's `sendToolListChanged` is a no-op (`mcp.js:763-768`), so this is silent.
4. Subscribe once: `onPreferencesMerged(values => { if (AI_IMAGES_PREF_KEY in values) applyImagesEnabled(values[AI_IMAGES_PREF_KEY] === "on"); })`. `applyImagesEnabled(next)` is idempotent: it tracks the current state and returns early when unchanged. When turning on: update the description first, then `enable()`. When turning off: `disable()` first, then restore the base description. Each `update` emits its own `notifications/tools/list_changed`; two notifications per flip are fine, the SDK has no batching API.
5. Do not send any manual notification. Do not call `server.server.notification`.
6. `shutdown` unsubscribes (cosmetic, keeps the listener list clean in tests that import main).

### 5.3 Behaviour at the edges

- A stale client calling `generate_image` while off receives the SDK's `Tool generate_image disabled` error result. Acceptable; no custom code.
- An in-flight generation is never aborted by the switch. If the switch turns off mid-generation, the current call completes and lands its image normally.
- Only the MCP process that received the browser POST reacts. Other running MCP processes converge on their next start, matching the existing preference model (`session.js:229-231`). Document, do not fix.

## 6. Settings sheet

New file `src/ui/hosts/live/ai-images-settings.js` exporting `registerAiImagesSettings()`. `src/ui/hosts/live/index.js` calls it only when `preferenceBacking` is non-null (`live/index.js:56-59`), which is exactly the MCP host: the web app never passes `options.preferences` (`src/web/app.js:829-835`). Frozen registers nothing. The module's code may ship in the web bundle; the section must never be registered there.

Section: `{ id: "ai-images", label: "Images", order: 7 }`. Renders one row following the Auto-tidy control (`src/ui/canvas-settings.js:18-46`): label "AI images", a `role="switch"` checkbox `data-ai-images-enabled` with `aria-labelledby`, and a subtitle: "Your agent can draw a picture when you ask for one, using Codex image generation. Each picture costs extra tokens, so this is off by default. Needs Codex installed and signed in."

Sync from `aiImagesEnabled()` on mount and on `onPreferenceChange("ai-images")`; write through `setAiImagesEnabled(checked)` on change. No Save button; live-apply like the rest of the sheet. Copy rules: no emojis, "Rabbithole" one word, no mention of the tool name `generate_image`.

Resulting section orders: MCP host `["Appearance","Canvas","Quick questions","Images"]`; web `["Appearance","Canvas","Quick questions","Model"]` unchanged; frozen unchanged.

## 7. Tests

Unit (`test/unit/`):
- prefs-store: `onPreferencesMerged` fires with the applied patch after a merge; a throwing listener is logged and the merge still resolves; unsubscribe stops delivery.
- `answerBranchDescription({imagesEnabled:false})` does not contain `generate_image` and is shorter than the true variant; the true variant equals `toolDefinitions` `answer_branch.description`.
- `buildServerInstructions({imagesEnabled:false})` does not contain `generate_image`; true variant equals `SERVER_INSTRUCTIONS`.
- `AI_IMAGES_PREF_KEY` equals the UI key.

Contracts (`test/contracts/mcp-copy.test.mjs`): keep the existing budgets on the full variants; add that neither off-variant mentions `generate_image`; keep the web-prompt assertion.

E2E (`test/e2e/cross-host-journey.test.mjs`, real stdio server through `startMcp()` at lines 360-393):
- Default store: `client.listTools()` has no `generate_image`, `answer_branch.description` lacks `generate_image`, `client.getInstructions()` lacks it.
- Store pre-seeded on (write `{"version":1,"values":{"rh-ai-images":"on"}}` to `<dir>/preferences.json` before `startMcp`): tool present, guidance present, instructions sentence present.
- Live flip: start with the default store, register `client.setNotificationHandler(ToolListChangedNotificationSchema, …)`, open a hole, POST `{"type":"preferences_patch","values":{"rh-ai-images":"on"}}` to the session's `/events`, await the notification, re-list: tool present and guidance present. Then patch `null`, await, re-list: gone again.
- The two existing image journeys (lines 81-205) pre-seed the store on.
- Settings surface (lines 285-321): local live sections now include "Images"; the switch writes `"on"` to `preferences.json` and unchecking removes the key.
- `test/e2e/auto-tidy.test.mjs` web order stays unchanged; frozen bundle assertions stay.
- `test/integration/image-experience.test.mjs`: add one explicit case that an existing generated image renders with the preference absent.

Direct-import tests (`test/integration/generate-image.test.mjs`, `test/contracts/generate-image.test.mjs`) and `scripts/imagegen-live-check.mjs` call `generateImage()` directly and stay as they are.

## 8. Docs

- CHANGELOG: the images bullet says off by default, enabled in Settings → Images.
- `docs/compatibility.md:78-82`: "when AI images are enabled in settings".
- SPEC-IMAGES.md: add a one-line pointer to this spec in §7 (surfaces).
- `npm run build:docs` regenerates `docs/generated/*` and `docs/tour.html`; commit them.

## 9. Out of scope

Downscaling the model-facing image, cross-process pref watching, live update of initialize instructions, a per-hole switch, an environment override.

## 10. Verification after landing

Restart the Rabbithole MCP server in Claude Code. With the switch off, `generate_image` must be absent from the tool list. Flip it on in the settings sheet; the tool must appear in the same session without a reconnect. If Claude Code ignores `list_changed`, the only change is the subtitle copy: add "Takes effect when the agent next connects."
