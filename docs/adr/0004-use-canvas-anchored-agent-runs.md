# ADR 0004: Use canvas-anchored agent runs

- Status: Accepted
- Date: 2026-07-28

## Context

The research canvas already represents questions, answers, branches, and follow-ups. A separate persistent Pi chat would create a second representation of the same research and compete with the canvas for screen space.

Pi still needs an entry point for broad requests that span multiple nodes, repositories, or corporate sources, and users need access to run progress and technical details.

## Decision

Nora does not provide a persistent standalone chat.

- `Ask Nora` opens a transient Research Prompt.
- A selected node scopes the prompt; no selection scopes it to the whole canvas.
- Agent results become canvas nodes or branches.
- Follow-ups continue from result nodes.
- Complete agent history is stored inside `.nora`.
- Technical execution details are available through run details rather than a conversation sidebar.

## Consequences

- The canvas remains the single user-facing representation of the research.
- Broad multi-source tasks remain possible without a permanent chat panel.
- Agent session history still exists for continuation and provenance even when it is not rendered as chat.
- Run-details and cancellation UI must be available without becoming a second conversation surface.

## Rejected Alternative

A persistent sidebar chat was rejected because it duplicates node conversations and reduces the space available to the infinite canvas.
