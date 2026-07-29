# Nora Specification

> Status: accepted. This document records the product and architecture decisions confirmed during the completed grill session. The completed implementation plan lives in `docs/plans/completed/20260728-nora-vscode-research-extension.md`. No unresolved product or architecture decision was introduced by implementation.

## Objective

Nora is a VS Code extension that opens `.nora` files as infinite canvases for branching research across project codebases and corporate sources such as Confluence and Jira.

Nora is not a general-purpose vector or diagram editor. The draw.io comparison applies only to the VS Code custom-editor experience: opening a file with a product-owned extension launches its visual editor.

## Confirmed Product Decisions

### Research experience

- Preserve the retained branching research experience unless explicitly removed later:
  - Reader and Canvas modes
  - branching from selected text
  - Markdown research nodes
  - origin navigation and branch relationships
  - follow-up questions and streamed answers
  - search and keyboard navigation
  - PDF, lenses, `show`, checks, snapshots, synthesis, and Markdown export remain included
- Remove delivery surfaces and infrastructure that existed only for predecessor standalone products:
  - external-agent MCP host
  - browser-launch and local HTTP/SSE session host
  - standalone BYOK browser application
  - browser-local and predecessor filesystem persistence
  - static-site deployment, fetch proxy, and marketing website
- Nora has no persistent standalone chat:
  - `Ask Nora` opens a transient research prompt
  - the selected node is the prompt context
  - no selection means the whole research canvas is the context
  - agent results become nodes or branches
  - follow-ups continue from result nodes
  - complete agent history remains in `.nora` and technical execution details are available as run details

### Evidence and provenance

- Research results carry durable source evidence.
- A source reference records:
  - source type
  - stable locator
  - title
  - cited excerpt
  - revision or commit when the source exposes one
- Code references use immutable commit permalinks.
- Nora may research arbitrary Git repositories, not only the currently open VS Code workspace.
- Nora clones repositories with Git and derives GitHub, GitLab, or Bitbucket permalinks from the repository remote.

### Agent permissions

- Pi is read-only with respect to researched code.
- Pi may read and search source files, modify the research canvas, and invoke configured MCP capabilities.
- Pi may not edit source repositories or execute unrestricted shell commands.
- The read-only restriction applies to Pi's local code-research tools, not to MCP capabilities.
- Nora does not classify, approve, or block MCP tools based on their side effects. The user is responsible for the capabilities and permissions exposed by each configured MCP server and skill.

### MCP

- Support `stdio` and Streamable HTTP transports.
- Support MCP tools and resources.
- Read standard workspace MCP configuration from `.vscode/mcp.json`.
- Do not import unrelated Pi, Codex, Claude, or other host-specific MCP configuration files.
- Nora adds no separate Workspace Trust, command-fingerprint approval, or read-only policy around configured MCP servers. Selecting and securing those servers is the user's responsibility.
- Nora does not authenticate third-party research sources.
- Authentication for Confluence, Jira, and other external sources belongs to the connected MCP servers or skills.
- External-source credentials must not be stored in `.nora` or VS Code SecretStorage by Nora.
- Nora never copies MCP configuration inputs, headers, environment values, or other connection credentials into `.nora`.
- Content returned by a user-configured MCP tool or resource is research data, not Nora-managed authentication state. Because Agent Run history is lossless, the exact bounded result shown to Pi is persisted even if that external server included sensitive content in its result. Selecting and securing such a server remains the user's responsibility.

### LLM providers and credentials

- Support Anthropic and OpenAI-compatible providers, including a corporate LiteLLM endpoint with a custom URL and token.
- Expose the other providers supported by Pi where they fit the same credential boundary.
- Support a local OpenAI Codex subscription through Pi.
- VS Code SecretStorage stores only LLM credentials, including API tokens and subscription/OAuth credentials required by the selected LLM provider.
- No credentials are stored in `.nora`.
- Named LLM profiles are configured globally in VS Code.
- Non-secret profile configuration includes provider, model, and endpoint.
- SecretStorage entries are keyed to the corresponding profile.
- Each profile gets an isolated Pi model runtime and credential adapter. Nora does not read `~/.pi/agent/models.json`, Pi credential files, or ambient provider API-key environment variables as a fallback.
- A `.nora` document remembers its selected profile ID and records provider, model, and endpoint provenance for every Agent Run.
- If the selected profile is unavailable on another machine, Nora asks the user to select a replacement and never falls back silently.

### Skills

- Discover workspace skills from `.agents/skills` and global skills from `~/.agents/skills`.
- Do not discover `.pi/skills` or other host-specific skill directories.
- A workspace skill overrides a global skill with the same name.
- Nora reports the conflict instead of merging two same-named skills.
- Nora does not need a skill installation or marketplace UI.
- Users are responsible for the behavior and security of the skills they install.

### `.nora` artifact

- All portable research data, including agent conversation history, lives in the `.nora` artifact.
- Credentials remain outside the artifact.
- Complete Git clones are derived cache and remain outside the artifact.
- `.nora` is a versioned ZIP container.
- Original PDFs and other acquired source attachments are embedded in the container.
- The container layout is:
  - `manifest.json` — format version, entry metadata, and checksums
  - `document.json` — canvas state, settings, and provenance
  - `runs/<run-id>.jsonl` — complete ordered Pi history
  - `assets/<sha256>` — original binary attachments addressed and deduplicated by content hash
- Agent history is lossless:
  - user prompts
  - assistant messages
  - tool names and arguments
  - the complete tool results seen by Pi, including MCP results
- Internal debug logs, reconnect attempts, and transport diagnostics are not part of agent history.
- A transcript event becomes visible only after one complete LF-terminated JSONL record has been appended. Nora atomically publishes the matching document revision and per-run byte cutoff; saves capture both together and never include unpublished trailing bytes. Undo removes a run reference/cutoff while retaining staged bytes for redo; bytes from invalidated redo history are never saved and are later garbage-collected.
- One attachment may be at most 100 MiB.
- The complete `.nora` artifact may be at most 1 GiB.
- An oversized addition is rejected before mutation and must not damage the last valid saved artifact.
- Released `.nora` versions migrate forward. This compatibility commitment begins with the first public Nora format; it does not apply to predecessor formats.
- Nora does not encrypt `.nora`. At-rest protection belongs to the filesystem and corporate data controls.
- No predecessor-format migration or backward compatibility is required. Nora is a new product.

### Agent run lifecycle

- At most one Pi Agent Run executes in a given `.nora` document.
- Different open `.nora` documents may run concurrently.
- Cancelling or failing a run preserves already-created canvas material.
- Preserved partial material and run history are marked `cancelled` or `failed`.
- Nora does not automatically roll back canvas mutations from an interrupted run.
- The provider emits only `CustomDocumentContentChangeEvent`; Nora owns its semantic undo/redo commands and standard desktop keybindings.
- When Nora undo returns exactly to the last saved snapshot, it uses the normal VS Code save path to resynchronize the editor's dirty indicator.
- An entire Agent Run is one Nora undo entry rather than token-level entries. Undoing an active run first cancels and drains it, captures the cancelled partial state for redo, then restores the exact pre-run document.
- Save and hot-exit backup may capture a consistent running prefix. A normal save rejects as a retryable conflict if the revision advanced during its write; otherwise a short finalization barrier delays newer change events until after VS Code marks the saved revision clean. Recovery marks a persisted running prefix interrupted.

### Privacy

- Nora collects no product telemetry.
- Nora sends no crash reports.
- LLM and user-configured MCP traffic are functional product traffic, not telemetry.

### Distribution

- Publish Nora to both the Visual Studio Marketplace and Open VSX from the first release.
- Build and publish from GitHub Actions; do not add Azure Pipelines.
- Visual Studio Marketplace publishing uses GitHub OIDC, an Entra application, `azure/login`, and `vsce publish --azure-credential`.
- Open VSX publishing uses an Open VSX access token and `ovsx publish`.
- Package once and publish the same VSIX to both registries.
- Ship one universal VSIX without native runtime dependencies.
- Remove the current optional `@napi-rs/canvas` path; PDF rendering and cropping run in the VS Code webview.
- Support desktop VS Code `^1.130.0` for the first release.
- Do not support VS Code Remote SSH, Dev Containers, Codespaces, or web extensions in the first release.

### Retrieval

- Nora does not build embeddings, a vector database, or a persistent semantic index.
- Code retrieval uses the read-only Pi tools over acquired Git worktrees.
- Corporate-source retrieval uses user-configured MCP tools and resources.
- Skills may orchestrate those capabilities but do not add a separate Nora indexing subsystem.

## Verified Research

### Digger `delve` workflow

Digger `0.26.0` uses this multi-repository pattern:

1. Synchronize every requested repository in one operation.
2. Maintain a shared cache as bare clones plus linked working copies.
3. Reuse the bare clones and fetch updates on subsequent runs.
4. Produce a manifest containing repository identity, absolute worktree path, and exact HEAD SHA.
5. Research repositories independently and store relative `path:line` evidence.
6. During synthesis, convert every code reference into a permalink pinned to the manifest SHA.

The GitLab permalink shape is:

```text
<gitlab-url>/<organization>/<repository>/-/blob/<commit-sha>/<path>#L<start>-<end>
```

Nora needs equivalent remote normalization for GitHub, GitLab, and Bitbucket rather than a GitLab-only manifest.

Official forge URL forms verified during the session:

- GitHub: `https://<host>/<owner>/<repo>/blob/<commit-sha>/<path>#L<start>-L<end>`
- GitLab: `https://<host>/<namespace>/<repo>/-/blob/<commit-sha>/<path>#L<start>-<end>`
- Bitbucket Cloud: `https://bitbucket.org/<workspace>/<repo>/src/<commit-sha>/<path>#<filename>-<line>`

Bitbucket line-range syntax and self-hosted forge URL variants must be implemented behind forge-specific adapters and verified against the target forge rather than inferred from the cloud URL.

### Pi integration facts

- The current package is `@earendil-works/pi-coding-agent`.
- The checked package version is `0.82.1` and requires Node.js `>=22.19.0`.
- Pi's SDK exposes `AgentSession`, direct event subscriptions, custom tools, resource loading, model runtime, and in-memory or persisted sessions.
- Pi's own RPC documentation recommends using `AgentSession` directly for a Node.js/TypeScript host.
- RPC mode is a JSONL protocol over a subprocess's stdin/stdout and is intended when process isolation or a non-Node host is required.
- Pi has built-in read-only tool selection: `read`, `grep`, `find`, and `ls`.
- Pi loads `.agents/skills` from the working directory and its ancestors.
- Pi intentionally has no built-in MCP client; MCP support is supplied through an extension or adapter.
- Pi supports ChatGPT Plus/Pro Codex subscription login.
- Custom models support OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI APIs.
- A LiteLLM deployment can be represented as a custom OpenAI-compatible provider with `baseUrl`, API type, model definitions, and a runtime credential.
- The locally installed VS Code `1.130.0` runs an extension host on Node.js `24.18.0`, which satisfies the current Pi SDK engine requirement.
- `@earendil-works/pi-coding-agent@0.82.1` has a required `@silvia-odwyer/photon-node` dependency whose executable payload is architecture-neutral WebAssembly, plus an optional `@mariozechner/clipboard` dependency whose platform packages contain native `.node` binaries.
- Nora may ship Photon’s architecture-neutral WebAssembly for selected image/PDF context preprocessing, but the universal VSIX must omit Pi's optional clipboard packages and must be checked for platform-specific `.node`, `.so`, `.dylib`, and `.dll` files before publication.

### Pi MCP adapter review

Four public Pi MCP packages were inspected:

| Package | Useful pattern | Why not adopt unchanged |
| --- | --- | --- |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | Token-efficient proxy tool, SDK factory, in-memory config, lazy lifecycle, reconnects, output bounds | Includes OAuth/keyring, MCP UI, sampling, elicitation, host-import behavior, and other surfaces Nora does not need |
| [`pi-mcp-extension`](https://github.com/irahardianto/pi-mcp-extension) | Direct-tool registration and transport lifecycle | Persists OAuth outside VS Code SecretStorage and still targets the old Pi package scope |
| [`@codella/pi-mcp-support`](https://github.com/codella/pi-packages/tree/main/packages/pi-mcp-support) | Small current-scope bridge using the official MCP SDK | Eager-only and lacks reconnect, output limits, policy enforcement, and robust configuration merging |
| [`@zhafron/pi-mcp-tools`](https://github.com/tickernelz/pi-mcp-tools) | Server/tool visibility and reconnect UX | Tools-only, stores secrets in settings examples, lacks an execution approval boundary, and targets the old Pi package scope |

No reviewed adapter enforces read-only behavior. MCP `readOnlyHint` is advisory metadata, not a security boundary.

The reusable MCP patterns for Nora are:

- one compact `mcp` proxy tool with search, describe, and call operations;
- an optional small direct-tool allowlist for frequently used tools;
- lazy connections, per-call timeouts, cancellation, bounded reconnects, clean child-process shutdown, stable tool identifiers, and list-change refresh;
- bounded/redacted outputs and no raw tool arguments, results, credentials, or URLs in diagnostic logs;
- an extension-owned MCP supervisor so opening multiple `.nora` documents does not spawn duplicate stdio servers;
- transparent forwarding of configured MCP capabilities without Nora attempting to infer their side effects.

### Distribution pipeline facts

- Visual Studio Marketplace packages and publishes extensions with `@vscode/vsce`.
- Microsoft recommends Microsoft Entra ID workload identity for automated publishing because global Azure DevOps PATs are retired on December 1, 2026.
- Open VSX publishes an existing VSIX with `ovsx publish <file>` and currently uses an Open VSX access token.
- Open VSX requires an Eclipse account, Publisher Agreement, namespace creation, and an access token before the first release.
- Both registries can receive the exact same prebuilt VSIX; building independently for each registry would make release provenance harder to verify.
- Visual Studio Marketplace can be published directly from GitHub Actions without a PAT:
  - grant the workflow `id-token: write`;
  - authenticate with `azure/login` using a federated Entra application;
  - publish with `vsce publish --azure-credential`.
- This path is demonstrated by a successful July 23, 2026 release run in `textlint/vscode-textlint` and a successful March 23, 2026 multi-extension Marketplace run in Microsoft's `microsoft/hve-core`.

## Current Recommendations

### Pi host

Embed Pi only through its SDK in the VS Code extension host.

Reasons:

- Nora is a Node.js/TypeScript host, which is the integration path Pi itself recommends for the SDK.
- Nora needs direct custom tools that mutate the active research canvas and forward MCP calls.
- SDK events map directly to webview streaming without an extra JSONL protocol and subprocess lifecycle.
- The current VS Code extension host satisfies Pi's Node requirement.
- Codex subscription and custom LiteLLM models use the same Pi `ModelRuntime`.

Do not ship or retain a JSON/RPC integration path. It would add subprocess packaging, crash/restart handling, protocol framing, and a separate bridge from child-process tools back to VS Code without serving a confirmed requirement.

### MCP bridge

Build a thin Nora-owned bridge on `@modelcontextprotocol/sdk` and expose it to Pi through custom tools. Borrow the proxy, lifecycle, output-bound, and refresh patterns from `pi-mcp-adapter`, but omit OAuth, MCP UI, sampling, elicitation, prompts, host-config imports, and native keyring dependencies.

Nora does not add an MCP approval or read-only layer. The thin bridge exposes the tools and resources selected by the user's MCP configuration. The user owns the trust decision for those servers and for installed skills.

### Repository acquisition

Treat complete Git clones as derived cache, not portable research data:

- keep a shared bare-clone/worktree cache under VS Code global storage;
- use the system Git executable, SSH agent, and credential helpers instead of implementing forge authentication in Nora;
- store the normalized remote, exact commit SHA, cited path/lines, and evidence excerpt inside `.nora`;
- remember the acquisition URL for cloned repositories;
- for an existing local repository, select the current branch's upstream remote, then `origin`, and ask if neither exists;
- preserve existing evidence at its original SHA; a refresh creates a new evidence revision rather than rewriting the old one.

This keeps `.nora` portable and self-explanatory without embedding entire repositories.
Forge handling must support corporate/self-hosted GitHub and GitLab. Bitbucket Cloud and Bitbucket Data Center use separate adapters because their permalink forms differ.

### `.nora` container

Use a versioned ZIP container because the artifact must hold conversation history, snapshots, original PDFs, and other binary assets. Structured entries use JSON and assets remain binary.

The ZIP choice implies a binary VS Code `CustomEditorProvider`, extension-owned save/backup/undo behavior, and no useful built-in textual Git diff.

XML was rejected because original binary sources are required. Encoding those sources as base64 would add size overhead and large textual rewrites without providing a product capability that JSON entries inside the ZIP lack.

Persist the complete Pi transcript needed to resume a research, including the full MCP tool results presented to the model. Do not persist adapter diagnostics or transport retry chatter. Enforce 100 MiB per attachment and 1 GiB per artifact before committing a save.

Use content-addressed `assets/<sha256>` entries so repeated attachments are stored once. Keep the manifest and document state separate from append-oriented JSONL Agent Run histories.

### Chat placement

Do not add a persistent chat surface. `Ask Nora` is a transient prompt scoped to a selected node or the whole canvas. Agent output is represented by nodes and branches, and existing node follow-ups continue the research. Complete Pi history is retained in the artifact for continuation and can be inspected as run details without duplicating the canvas into a second conversation UI.

### Agent run lifecycle

Allow one active Agent Run per document and allow different documents to run concurrently. Cancellation and failure preserve useful partial results, label their run status, and do not perform an automatic rollback.

### Compatibility and privacy

Migrate released `.nora` versions forward while keeping predecessor-format migration out of scope. Do not implement application-level artifact encryption, telemetry, or crash reporting.

### Release pipeline

Keep all CI and release automation in GitHub Actions. On a version tag:

1. Run the required tests and deterministic build checks.
2. Package one VSIX.
3. Attach the VSIX and checksum to the GitHub Release.
4. Authenticate to Microsoft Entra through GitHub OIDC and publish the same VSIX to Visual Studio Marketplace with `vsce --azure-credential`.
5. Publish the same VSIX to Open VSX with `ovsx`.

The Marketplace path requires initial Entra application/federated-credential and publisher setup, but it does not require moving the release workflow to Azure Pipelines or keeping a retiring Marketplace PAT.

### Continuous integration

- Keep CI free of static-site deployment workflows.
- Run CI only on Linux.
- Use Node.js 24.
- Run type checks, unit tests, contract tests, integration tests, deterministic build checks, VS Code integration tests, and VSIX installation smoke tests.
- Run browser-level webview tests only in Chromium; do not install or test Firefox or WebKit.
- Build one universal VSIX without native runtime dependencies.
- Do not commit generated extension or webview bundles; build them in CI and for release.
- Accept that Windows and macOS receive no dedicated CI signal in the first release.

## Unresolved Decisions

No unresolved product or architecture decisions remain from the grill session.

## Primary References

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [VS Code extension publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Open VSX extension publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions)
- [GitHub Actions Marketplace workflow in `textlint/vscode-textlint`](https://github.com/textlint/vscode-textlint/blob/master/.github/workflows/publish.yaml)
- [Successful `textlint/vscode-textlint` Marketplace release run](https://github.com/textlint/vscode-textlint/actions/runs/30004631279)
- [GitHub Actions Marketplace workflow in `microsoft/hve-core`](https://github.com/microsoft/hve-core/blob/main/.github/workflows/extension-marketplace-publish.yml)
- [Successful `microsoft/hve-core` Marketplace run](https://github.com/microsoft/hve-core/actions/runs/23457498873)
- [GitHub permanent links](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files)
- [GitLab repository files](https://docs.gitlab.com/user/project/repository/files/)
- [Bitbucket Cloud source links](https://support.atlassian.com/bitbucket-cloud/docs/hyperlink-to-source-code-in-bitbucket/)
