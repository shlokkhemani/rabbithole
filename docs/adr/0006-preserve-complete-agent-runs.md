# ADR 0006: Preserve complete agent runs

- Status: Accepted
- Date: 2026-07-28

## Context

A `.nora` file must preserve enough information to resume a Pi session and explain how research material was produced. Partial transcripts or omitted MCP results could change the context seen by a resumed agent.

Runs may be cancelled or fail after already adding useful material to the canvas.

## Decision

Store the complete model-facing Pi transcript inside `.nora`, including:

- user prompts and assistant messages;
- tool names and arguments;
- complete tool results presented to Pi, including MCP results.

Do not store internal adapter diagnostics, reconnect attempts, or transport logs as agent history.

Allow one active Agent Run per `.nora` document. Different documents may run concurrently.

When a run is cancelled or fails, retain its transcript and already-created canvas material, mark the run `cancelled` or `failed`, and do not perform an automatic rollback.

## Consequences

- A research can resume with the exact model-facing history.
- `.nora` may contain substantial or sensitive corporate-source data.
- Concurrent research remains possible across documents without introducing conflicting runs within one canvas.
- Users may manually remove unwanted partial results after a failed or cancelled run.

## Rejected Alternatives

- Storing only visible nodes was rejected because it cannot reproduce Pi's session context.
- Automatic rollback was rejected because it could destroy useful partial research and complicate tool transaction semantics.
