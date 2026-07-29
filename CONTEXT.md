# Nora Context

Nora is a VS Code extension for conducting research across project codebases and
corporate sources on an infinite canvas. A `.nora` file is a portable research
archive opened by Nora's custom editor.

## Product Language

Research: an investigation conducted on an infinite canvas using material from
codebases, attached files, and user-configured corporate sources.
Avoid: diagram, drawing, standalone chat.

Research Canvas: the Reader and Canvas experience opened from a `.nora` file.
Avoid: vector editor, whiteboard.

Source Reference: durable provenance attached to research material, identifying
the source type, stable locator, title, excerpt, revision or commit when
available, and capture time.
Avoid: unattributed copy.

Repository Permalink: an immutable GitHub, GitLab, Bitbucket Cloud, or
Bitbucket Data Center URL pinned to an exact commit, path, and line range when
the forge supports that shape.
Avoid: branch link, local worktree path.

Research Prompt: a transient request to Pi, scoped to the selected canvas node
or to the whole research when nothing is selected.
Avoid: permanent chat message.

Agent Run: one Pi execution started by a Research Prompt. Output becomes canvas
material; model-facing history is stored in the `.nora` archive and exposed
through Run Details.
Avoid: chat thread.

Attachment: byte-exact source material stored in `assets/<sha256>` inside the
`.nora` archive.
Avoid: derived cache.

LLM Profile: non-secret global VS Code configuration naming a provider, model,
endpoint, and Pi API mapping. The matching credential lives in SecretStorage.
Avoid: putting tokens in settings or documents.

MCP Source: a user-configured MCP server from `.vscode/mcp.json`. Nora connects
to it faithfully and persists bounded model-facing results as research history.
Avoid: implying Nora authenticates or approves the external source.

## Current Boundaries

- Nora runs only as a desktop VS Code extension in v1.
- `.nora` is a versioned ZIP archive with `manifest.json`, `document.json`,
  `runs/*.jsonl`, and `assets/<sha256>`.
- Pi is embedded through the SDK and receives Nora-owned read-only code tools,
  skills, canvas tools, and MCP tools/resources.
- Nora does not provide corporate-source authentication, MCP side-effect
  approval, artifact encryption, telemetry, crash reporting, or Remote/web
  extension support.
