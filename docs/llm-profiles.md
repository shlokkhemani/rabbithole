# Nora LLM Profiles

Nora uses global VS Code configuration for non-secret LLM profile metadata and
VS Code SecretStorage for the credential bound to each profile.

The selected profile ID is saved in `.nora`; credentials are not.

## Setting

Profiles live in `nora.llm.profiles`:

```json
{
  "nora.llm.profiles": [
    {
      "id": "litellm-research",
      "label": "Corporate LiteLLM",
      "provider": "litellm",
      "model": "team/model",
      "baseUrl": "https://litellm.example.test/v1",
      "api": "openai-completions",
      "customModel": {
        "contextWindow": 128000,
        "maxTokens": 4096,
        "input": ["text", "image"],
        "reasoning": false
      }
    }
  ]
}
```

Required fields:

- `id`: stable ASCII profile ID, unique across the array.
- `provider`: Pi provider ID or custom provider ID.
- `model`: exact model ID resolved by the Pi runtime.

Optional fields:

- `label`: display label. Defaults to `id`.
- `baseUrl`: HTTP or HTTPS endpoint for custom OpenAI-compatible providers.
- `api`: `openai-completions` or `openai-responses`. Defaults to
  `openai-completions` when `baseUrl` is set.
- `piApiType`: accepted as an alias for `api`.
- `customModel`: model metadata for custom OpenAI-compatible providers.

`customModel` may include:

- `name`
- `contextWindow`
- `maxTokens`
- `reasoning`
- `input`: `text`, `image`, or both.
- `cost`
- `thinkingLevelMap`
- `compat`

`customModel` requires `baseUrl`.

## Validation and Secret Boundary

Nora rejects profile configuration that contains secret-looking field names such
as token, key, password, credential, authorization, header, cookie, or bearer.

Nora also rejects `baseUrl` values that contain URL userinfo or
credential-bearing query parameters. A corporate endpoint URL is configuration;
its API token belongs in SecretStorage.

At run start, Nora refuses to construct a runtime when:

- No profile is selected in the document.
- The selected profile ID no longer exists.
- The profile is invalid.
- The profile has no SecretStorage credential.
- The exact provider/model pair cannot be resolved.

Nora never silently falls back to Pi model files, Pi credential files, or
provider API-key environment variables.

## Credentials

SecretStorage keys use this form:

```text
nora.llm.credential.<profile-id>
```

`Nora: Set Credential` stores an API-key credential for the selected profile.
The stored JSON has this shape:

```json
{
  "type": "api_key",
  "key": "stored-in-secretstorage"
}
```

`Nora: Sign In` delegates to Pi's provider-owned OAuth flow. OAuth credentials
are also stored under the selected profile key and are isolated from other
profiles, even when two profiles use the same provider.

`Nora: Sign Out` deletes the selected profile's SecretStorage entry.

## Runtime Construction

Each run builds a Pi `ModelRuntime` for the selected profile with:

- A profile-scoped credential adapter.
- `modelsPath: null`.
- An in-memory model store.
- Model-catalog network refresh disabled.

For `baseUrl` profiles, Nora registers a custom OpenAI-compatible provider using
the configured endpoint, model, API type, and custom model metadata.

For built-in Pi providers, Nora resolves the exact provider/model pair from the
installed Pi runtime. Codex subscription profiles use Pi's provider-owned sign-in
flow.

## Run Provenance

At run start, Nora copies non-secret provenance into the run summary:

- Profile ID.
- Provider.
- Model.
- Endpoint when configured or reported by the runtime.

This provenance is portable research metadata. Credentials, access tokens,
refresh tokens, authorization headers, and provider environment values are never
copied into `.nora`, logs, snapshots, Markdown exports, or webview messages.
