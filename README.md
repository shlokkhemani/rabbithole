# Nora

Nora is a VS Code extension for research over codebases and corporate sources.
It opens `.nora` files as a custom infinite-canvas editor, runs Pi in the VS Code
extension host, and saves the full research state in one portable archive.

Nora is not a hosted service, a browser app, or a terminal-agent MCP server.
Research happens inside desktop VS Code and is saved to local `.nora` files.

## Requirements

- Desktop VS Code `1.130.0` or newer.
- Local `file:` documents. VS Code Remote, virtual workspaces, Codespaces, and
  web extensions are not supported in v1.
- Node.js 24 only for developing or packaging Nora from source.

## Install

Install Nora from one of the distribution channels:

- Visual Studio Marketplace: install `r13v.nora` from the VS Code Extensions
  view.
- Open VSX: install `r13v.nora` from an Open VSX enabled editor.
- GitHub Release VSIX: download `nora.vsix`, then use `Extensions: Install from
  VSIX...` in VS Code.

## Quick Start

1. Run `Nora: New Research` and save a `.nora` file.
2. Configure at least one global LLM profile in VS Code settings.
3. Run `Nora: Set Credential` for API-key profiles, or `Nora: Sign In` for
   provider-owned OAuth flows such as Codex subscription login.
4. Run `Nora: Select Profile` while the `.nora` document is open.
5. Add source material with `Nora: Add Repository` or `Nora: Add Attachment`.
6. Use `Ask Nora` from the canvas or from a selected node. Results become canvas
   nodes, not a separate persistent chat.
7. Use `Nora: Export Markdown` or `Nora: Export Snapshot` when you need a
   shareable research output.

## LLM Profiles

Profiles are non-secret VS Code settings. Credentials are stored separately in
VS Code SecretStorage.

```json
{
  "nora.llm.profiles": [
    {
      "id": "anthropic-research",
      "label": "Anthropic research",
      "provider": "anthropic",
      "model": "replace-with-pi-model-id"
    },
    {
      "id": "litellm-research",
      "label": "Corporate LiteLLM",
      "provider": "litellm",
      "model": "replace-with-routed-model",
      "baseUrl": "https://litellm.example.test/v1",
      "api": "openai-completions",
      "customModel": {
        "contextWindow": 128000,
        "maxTokens": 4096,
        "input": ["text", "image"]
      }
    },
    {
      "id": "codex-subscription",
      "label": "Codex subscription",
      "provider": "openai-codex",
      "model": "replace-with-pi-model-id"
    }
  ],
  "nora.mcp.directTools": ["jira/search"]
}
```

Profile IDs must be stable ASCII text. Nora rejects secret-looking fields in
profile configuration and rejects endpoint URLs that contain URL userinfo or
credential-bearing query parameters.

Use `Nora: Set Credential` to enter a LiteLLM or API provider token. Use
`Nora: Sign In` for profiles that rely on Pi's provider-owned OAuth flow.
Credentials never enter settings, `.nora`, snapshots, Markdown exports, or logs.

See `docs/llm-profiles.md` for the full profile and credential boundary.

## MCP and Skills

Nora reads MCP servers from the active workspace's `.vscode/mcp.json`. It
supports stdio and Streamable HTTP servers, tools, and resources. Resolved MCP
inputs, headers, and environment values live only for the connection lifetime.

```jsonc
{
  "inputs": [
    {
      "id": "jira-token",
      "type": "promptString",
      "description": "Jira MCP token",
      "password": true
    }
  ],
  "servers": {
    "jira": {
      "type": "http",
      "url": "https://mcp.example.test/mcp",
      "headers": {
        "Authorization": "Bearer ${input:jira-token}"
      }
    },
    "docs": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/docs-mcp.js"],
      "cwd": "${workspaceFolder}",
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

Skills are loaded from `<workspace>/.agents/skills` and `~/.agents/skills`.
Workspace skills win over global skills with the same name and Nora reports the
shadowing diagnostic. `.pi/skills` is not read.

Nora does not authenticate corporate sources, approve MCP tool calls, classify
MCP side effects, or enforce a read-only MCP policy. Users are responsible for
the servers, skills, headers, tokens, and data they expose. Model-facing MCP
results are persisted as research history after Nora's output bounds are
applied.

See `docs/mcp.md` for supported fields and rejected configuration.

## Repositories and Evidence

`Nora: Add Repository` accepts remote Git URLs and local repositories. Nora uses
system Git and the user's normal SSH agent, credential helper, proxy, and
certificate configuration. It does not store Git credentials.

Repositories are acquired into a shared cache under VS Code global storage.
Research tools read immutable detached worktrees at exact commits. Evidence
records store sanitized remote metadata, commit SHA, path, line range, excerpt,
and an immutable GitHub, GitLab, Bitbucket Cloud, or Bitbucket Data Center
permalink when Nora can construct one.

See `docs/repositories-and-evidence.md` for cache layout, remote precedence, and
permalink forms.

## Attachments, PDFs, and Exports

PDFs, images, and other attachments are stored byte-exact in the `.nora` archive
as content-addressed assets. PDFs render in the webview with bundled PDF.js.
Crops and selected PDF context become normal attachments and evidence.

Markdown export contains visible research nodes and evidence footnotes.
Snapshot export writes a self-contained, inert HTML document with the referenced
assets and frozen reader/canvas client. Exports intentionally exclude selected
profile IDs, transcripts, MCP configuration, tool arguments/results, local cache
paths, and Nora-managed credentials.

## What Nora Does Not Do

- No corporate-source authentication. Configure that in your MCP servers or
  skills.
- No MCP side-effect restrictions or approvals.
- No application-level encryption for `.nora` files.
- No product telemetry or crash reporting.
- No Remote SSH, Dev Containers, Codespaces, virtual workspaces, or web
  extension runtime in v1.
- No import path for pre-Nora document formats.

## Developing Nora

```bash
npm ci --omit=optional
npm run build
npm run check
npm test
```

Generated extension bundles are written to `out/`. Packaged VSIX files are
written to `artifacts/`. Neither directory is committed.

See `AGENTS.md` for repository conventions and `docs/testing.md` for suite
ownership and validation commands.
