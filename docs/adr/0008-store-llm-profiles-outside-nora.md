# ADR 0008: Store LLM profiles outside `.nora`

- Status: Accepted
- Date: 2026-07-28

## Context

Nora supports Codex subscription login, Anthropic, OpenAI-compatible providers, and corporate LiteLLM endpoints. Research documents must preserve model provenance without carrying credentials or silently switching models on another machine.

## Decision

- Define named LLM profiles globally in VS Code settings.
- Store non-secret provider, model, and endpoint configuration in the profile.
- Store API tokens and subscription/OAuth credentials in VS Code SecretStorage, keyed to the profile.
- Store the selected profile ID in `.nora`.
- Record provider, model, and endpoint provenance for each Agent Run.
- If a selected profile is unavailable, require an explicit replacement selection and never fall back silently.

## Consequences

- Credentials never enter portable research artifacts.
- Different documents may select different local profiles.
- A teammate opening a `.nora` can inspect model provenance but must map unavailable profiles to credentials they control.
- Continuing a research with a replacement profile is an explicit and auditable choice.

## Rejected Alternatives

- Embedding provider credentials in `.nora` was rejected as a secret leak.
- A single global active model was rejected because different research documents may require different providers.
- Silent fallback was rejected because it would change cost, data routing, and model behavior without user consent.
