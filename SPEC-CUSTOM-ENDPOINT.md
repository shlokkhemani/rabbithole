# SPEC — Custom OpenAI-compatible endpoint

Closes #16. Web BYOK only (local npx mode uses Claude Code as the brain).

Three providers, three mental models: **OpenRouter** (hosted, pay), **Local** (Ollama on your
machine), **Custom** (your own OpenAI-compatible endpoint). Local is untouched and stays
first-class — no regressions to its guided setup, vision probe, or recovery dialog.

Minimum viable UI. No autofill chips, no CORS panel, no derived display names, no nudges.
One endpoint field, one optional key field, one honest status line.

## 1. Rename: Local's preset id `custom` → `local`

The existing Local preset is literally id `"custom"`, so `preset.id === "custom"` currently
means Ollama. Shipping a feature named "Custom" on top of that is a permanent landmine.

- `PROVIDERS.local` replaces `PROVIDERS.custom` (same fields, `label: "Local"`).
- `providerFor("custom")` returns `local` — a one-line alias, kept forever. This covers
  legacy `rh-web-settings.preset` and `generation_setup.preset` embedded in saved/shared
  holes, so no data migration is needed anywhere.
- Update every `preset.id === "custom"` site (settings-popover, pdf-transcription, app.js,
  ollama-recovery/diagnostics, `data-preset` CSS hooks) to `"local"`.
- No key was ever stored for Local (`requires_key: false`), so `rh-web-api-keys` needs no
  migration.

## 2. New preset

```js
custom_endpoint: {
  id: "custom_endpoint",
  label: "Custom",
  model_source: "custom",
  base_url: "",
  kind: "openai-compatible",
  requires_key: false,     // usable without a key
  allows_key: true,        // but the key field is shown
  requires_base_url: true,
  model: "",
  transcribe_model: "",
}
```

Segment order: OpenRouter · Local · Custom. OpenRouter stays `recommended` and stays the
first-run default.

## 3. Settings panel — Custom only

**Endpoint** — top-level field (not inside `<details>`; Local keeps its disclosure as-is).
Label "Endpoint", placeholder `https://api.example.com/v1`, hint "OpenAI-compatible base URL."

**API key** — rendered when `requires_key || allows_key`. Label "API key" for Custom
(`preset.key_label` overriding the existing `` `${preset.label} key` ``, which would read
"Custom key"). Hint: "Optional — leave blank if your endpoint doesn't need one." Reuses the
existing "Remember on this device" switch. No remote validation: `key-validation.js`'s
non-OpenRouter path already just saves.

**Status line** (`#endpoint-status`, below the endpoint field) — the whole feedback surface:

| State | Copy |
| --- | --- |
| probing | `Connecting…` |
| 200, n models | `Connected · {n} models` |
| 200, empty list | `Connected · no models listed` |
| 401/403, no key | `This endpoint needs an API key.` (focus the key field) |
| 401/403, key set | `This endpoint rejected the key.` |
| other HTTP | `Endpoint returned HTTP {status}.` |
| network error | `Couldn't reach {host}. Check the URL, and that the server allows requests from this page.` |

The last row is the CORS case — one honest sentence, no panel.

**Model / PDF transcription pickers** — reuse the Local combobox (list + free-text
"Use X as-is"), populated from the probe. Free text must work when `/models` is unimplemented.

## 4. Probe

Extract from `local-model-catalog.js` into `src/web/brain/model-endpoint.js`:

```js
fetchOpenAICompatibleModels(baseUrl, { apiKey, signal }) -> [{ id, name }]
```

- `GET {base}/models`, `Accept: application/json`, `Authorization: Bearer` only when a key
  is present, existing loopback `targetAddressSpace` hint retained.
- Tolerates Ollama's `data: null`; throws on non-array.
- Thrown errors carry `error.status` so the popover can tell 401 from a network failure.

`discoverLocalModels` becomes that function plus the existing `/api/show` vision enrichment —
behavior unchanged, no key. Custom does **not** call `/api/show`.

Probe runs on: selecting Custom with a stored endpoint, endpoint change, key change.

## 5. Readiness

- `pdfTranscriptionCapability` / `detectPdfTranscriptionCapability`: the vision gate is
  Local-only (`preset.id !== "local"` keeps the trust-the-configured-model path). Custom
  therefore behaves like OpenRouter — never silently disables transcription. With no
  transcribe model chosen it reports the existing `model_required` state.
- `getGenerationSetupStatus`: add `missing_endpoint` when `preset.requires_base_url` and no
  `base_url`.
- Brain creation (`app.js:795`, `app.js:1032`) currently reads
  `key || !providerFor(...).requires_key`. Replace both with one helper: Custom needs a
  base URL and a model; OpenRouter needs a key; Local unchanged.
- `#complete-model-setup` stays disabled for Custom until the probe connects and a model is
  chosen (mirror `localModelReady`).

## 6. Per-provider settings persistence

Today `settingsForProvider` resets `base_url`/`model`/`transcribe_model` from preset
defaults on every switch, so OpenRouter → Custom → OpenRouter → Custom wipes the typed
endpoint and model. Fix: `rh-web-settings` gains
`providers: { [id]: { base_url, model, transcribe_model } }`; switching restores that
provider's saved slot, falling back to preset defaults. Saving writes the active provider's
slot. Migration: an existing flat settings object seeds the slot for its current preset.

## 7. Tests

Existing suites must pass unchanged except the two `.provider-choice` assertions in
`test/e2e/web-app-setup.test.mjs` that pin `["OpenRouter", "Local"]`.

- **unit** `provider-registry` — `"custom"` aliases to `local`; per-provider round-trip
  through `settingsForProvider`; defaults.
- **unit** `model-endpoint` — auth header present only with a key; `error.status` on 401 and
  500; `data: null` → `[]`; non-array → throws; loopback hint.
- **unit** `pdf-transcription-capability` — extend: Custom trusts the configured model and is
  never gated on a vision probe.
- **integration** settings popover, fetch-stubbed across every status-line state above, plus
  key persistence and lossless provider switching.
- **e2e** `web-app-setup` + `test/support/provider-mock.mjs` — configure Custom against the
  mock with a key, generate a document end to end, assert the mock received
  `Authorization: Bearer …`; assert a typed endpoint survives a round trip through
  OpenRouter; assert the Local journey is untouched.
- Check `test/contracts/` for provider-shape assumptions.

## 8. Visual

`.provider-choice` must hold three segments cleanly at the popover's width and on mobile.

## 9. Decided while building

- **CSP had to change.** `connect-src` was an allowlist of known hosts, so an arbitrary
  endpoint was blocked before any of this could run. `build.mjs` now includes `https:`.
  `script-src` stays pinned to `'self'`, which is what keeps that safe. (Section 10 revises
  the plain-http half of this.)
- **Relative URLs are refused before the fetch.** `api.example.com/v1` would resolve against
  this origin and probe the app itself, so `isHttpUrl` gates both the probe and brain
  creation: "Enter a full URL, like https://api.example.com/v1."
- **PDF transcription follows the chat model.** Nothing can tell which model on an arbitrary
  endpoint sees images, so connecting fills an empty transcribe model with the chosen chat
  model rather than leaving the picker showing a model the capability check doesn't agree
  with. A model that can't do vision fails loudly at request time, which the spec prefers
  over silently switching transcription off.
- **Disabled "Finish setup" now looks disabled** (`.web-primary:disabled`). It was styled
  identically to the enabled state; Custom leaves it gated for most of the flow, which made
  a pre-existing gap impossible to ignore.
- **Regression caught by the new tests:** the shared-fetch refactor had dropped
  `loopbackFetchHint` from `local-model-catalog.js`, which silently broke Ollama's `/api/show`
  vision probe. Fixed by exporting it from `model-endpoint.js`.

## 10. Follow-up: a model on the local network (issue #16)

The issue author's actual case was a phone on rabbithole.ing pointed at Ollama on a LAN IP.
Section 9 assumed mixed content made that impossible. Measured in Chrome 149, it doesn't:

- Mixed content is only a **warning** for a local-network request, not a block. The block is
  Chrome's Local Network Access permission (shipped in 142) — "Access other devices on your
  local network", Block/Allow. Denied, the fetch fails as `TypeError: Failed to fetch`, which
  is indistinguishable from an unreachable host.
- `Access-Control-Allow-Private-Network` is **not** required. The permission replaced it, so
  Ollama needs nothing beyond `OLLAMA_HOST=0.0.0.0` and `OLLAMA_ORIGINS`. Verified against a
  server sending exactly Ollama's headers and no more.
- Therefore `connect-src` needs `http:`. The private ranges have no CSP pattern, and the
  widening is small: from an https page the browser blocks plain http anyway except on this
  machine and, behind that prompt, the local network.
- `loopbackFetchHint` became `addressSpaceHint`, which also claims `"local"` for RFC 1918,
  link-local, IPv6 ULA, and `.local`. It stays silent about anything that might resolve to
  the public internet, including CGNAT (100.64/10, where Tailscale lives) — Chrome fails a
  request whose declared address space doesn't match the one it resolves to.
- `streamOpenAICompatible` never sent the hint at all, so generation would have failed at an
  address discovery had just reached. Fixed, and pinned by a test.

Not covered: Safari, which has no equivalent. On iOS the answer is to serve the build from
the same machine, so page and endpoint are both plain http.
