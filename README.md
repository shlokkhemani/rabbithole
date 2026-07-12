# Rabbithole

**An infinite canvas for learning.** Open a document, select any text, ask a
question — and the answer opens as a fully-rendered child document. Recurse as
deep as you like. Every hole is saved and revisitable.

Rabbithole has two ways in: a local MCP server for terminal agents, and a
static browser app for humans who want to bring their own model key. In the MCP
path, your agent (Claude Code, Codex, or any MCP client) does the answering and
Rabbithole gives it a canvas in your browser. Everything in that path runs
locally: no account, no API keys, nothing leaves your machine.

🌐 **[rabbithole.ing](https://rabbithole.ing)**

## Use it on the web

Open **[rabbithole.ing](https://rabbithole.ing)** for the browser app:
bring your own key, choose OpenRouter (recommended), Anthropic, OpenAI, or a
local OpenAI-compatible endpoint, and start from pasted markdown, PDFs, URLs,
or `.rabbithole` files. Provider keys stay in your browser and are sent only to
the provider origin you configure. Holes persist in IndexedDB, so the app keeps
working offline-ish after it loads, and `.rabbithole` export/import keeps your
work portable.

Each browser-created document gets a memorable local URL such as
`rabbithole.ing/curious-teacup-abcdef`. The path identifies a record in that
browser's IndexedDB; it is not a public sharing link and will not open the same
document on another browser unless the `.rabbithole` file is imported there.

Self-hosting is static: `web/dist` can be served by any host. The optional
`workers/fetch-proxy` Cloudflare Worker enables URL ingestion for sources that
block browser CORS. Hosts must serve `index.html` as the fallback for unknown
single-segment paths so document URLs survive a direct visit or refresh.

## Quick start

Requires Node 18+ and a browser. Pick your agent:

**Claude Code**

```bash
claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

Claude Code's default stdio MCP timeout is already long enough for Rabbithole's
blocking wait. If you manage `.mcp.json` manually, this optional per-server
field is also fine:

```json
{
  "mcpServers": {
    "rabbithole": {
      "command": "npx",
      "args": ["-y", "github:shlokkhemani/rabbithole"],
      "timeout": 3600000
    }
  }
}
```

**Codex**

```bash
codex mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

Then add the timeout field in `~/.codex/config.toml`:

```toml
[mcp_servers.rabbithole]
command = "npx"
args = ["-y", "github:shlokkhemani/rabbithole"]
tool_timeout_sec = 600
```

`codex mcp add` cannot set `tool_timeout_sec`; edit the config file directly.

**Any other MCP client** — add this to its MCP config:

```json
{
  "mcpServers": {
    "rabbithole": {
      "command": "npx",
      "args": ["-y", "github:shlokkhemani/rabbithole"]
    }
  }
}
```

Then start a new agent session and say:

> open this document in rabbithole

A browser tab opens. Select any text on the page, ask a question (or tap a
lens — Explain · ELI5 · Example · Go Deeper), and the answer streams in as a
new document. Keep going.

<details>
<summary><strong>Prefer running from a local clone?</strong> (faster startup, easier hacking)</summary>

```bash
git clone https://github.com/shlokkhemani/rabbithole.git
cd rabbithole && npm install
claude mcp add rabbithole -- node "$(pwd)/bin/mcp-server.js"
```

</details>

## 🤖 If you are an AI agent setting this up

Follow these steps exactly:

1. **Check Node**: `node --version` must be ≥ 18.
2. **Register the server** with the one-liner above that matches the agent
   you are running inside (`claude mcp add …` for Claude Code, `codex mcp add …`
   for Codex, or write the JSON block into the client's MCP config file).
   The `npx -y github:shlokkhemani/rabbithole` form needs no clone and no
   install step — npx fetches this repo and runs `bin/mcp-server.js` over stdio.
   For Codex, also add `tool_timeout_sec = 600` under
   `[mcp_servers.rabbithole]` in `~/.codex/config.toml`; `codex mcp add` cannot
   set that field.
3. **Verify**: after the client reconnects, three tools should be available —
   `open_rabbithole`, `answer_branch`, `list_rabbitholes`. (In Claude Code,
   `claude mcp list` should show `rabbithole` as connected. The server itself
   also responds to a standard MCP `initialize` with server name `rabbithole`.)
4. **Tell your human what to do next**: they should start a session and say
   *"open &lt;some document&gt; in rabbithole"* — you then call `open_rabbithole`
   with `{ title, content }` (or `{ title, file_path }`; add `base_url` when
   the markdown came from a URL or repo; add `assets` for local images referenced
   as `asset:name.png`), which blocks until they select text and ask. Answer
   with `answer_branch` (stream chunks with `partial: true`, finish with a
   titled final call) and keep looping until `status='session_closed'`. If a
   long wait returns `status='keep_listening'`, immediately call
   `open_rabbithole` with the returned `{ hole_id }` and do not re-send content.

Notes for you: the tool call blocks by design (long-poll) — that is normal, not
a hang. First `npx` run takes ~15–30s while it fetches the repo; later runs are
cached. If the browser must not auto-open (headless), set
`RABBITHOLE_NO_BROWSER=1` in the server's env.

## Tools

| Tool | What it does |
|------|--------------|
| `open_rabbithole` | Open a doc (`{ title, content }` / `{ title, file_path }`, optional `base_url`, optional `assets`) or resume one (`{ hole_id }`). A PDF `file_path` opens natively: rendered pages, selectable text, and box-select — no markdown authoring needed (`title` optional; PDF metadata or filename is used). Opens the canvas in the browser and blocks until the human asks something. |
| `answer_branch` | Answer a pending branch request → a child document. Stream with `partial: true` chunks, then finish with a normal call carrying the node title; use `base_url` for fetched markdown and `assets` for local images referenced as `asset:name.png`. A `branch_request` from a PDF may include `region.image_path` — read that image before answering. Also streams "Convert to document" transcriptions when a `convert_request` arrives. |
| `list_rabbitholes` | List saved holes to resume by id. |

The loop: `open_rabbithole` → `branch_request` → `answer_branch` → `branch_request` → … → `session_closed`.
Long waits may return `keep_listening`; immediately call `open_rabbithole`
again with the returned `hole_id`. If the host reports a tool timeout, do the
same — questions are saved.

For research PDFs, use page renders as the dependable figure source and embedded
rasters when they are cleaner. For arXiv links, prefer fetching the HTML version
and opening that content with `base_url` instead of ingesting the PDF.

## What's inside

- **Reader mode (default):** fullscreen reading, branches sidebar, breadcrumbs;
  selections become inline marks (pending → ready); clicking a mark jumps to
  its answer; child docs carry a FROM strip that jumps back to the exact origin.
- **Streamed answers:** words appear live with a breathing caret — in the
  reader, the thread, and the canvas card.
- **Rich Markdown:** answers can use math, highlighted language code fences,
  `show` diagrams, URL-based resolution for relative links/images, and local
  image assets via `asset:name.png`; source stays as Markdown for copy/export,
  while frozen snapshots inline assets into the HTML.
- **Interactive checks:** answer multiple-choice questions inline; progress survives reloads and portable backups, while shared snapshots start clean.
- **Lenses:** one-tap presets on the ask popup — Explain · ELI5 · Example ·
  Go Deeper (keys 1–4).
- **Follow-up chat:** a composer under each document asks about the doc as a
  whole; answers render inline and are branchable like any other text.
- **Canvas mode:** infinite pan/zoom, draggable/resizable cards, edges that
  attach to the exact selected text in the parent, collapse, auto-layout.
- **Navigation:** `j`/`k` walk marks, `↵` opens, `⌫` jumps back up, `⌘K` searches
  the whole hole.
- **Share/export:** copy any trail or document as Markdown; use **Download
  snapshot** for a share/read-anywhere interchange `.html`; use **Export
  Rabbithole** for a `.rabbithole` backup or device transfer; or ask the agent
  for a synthesis of the whole journey.
- **Durable asks:** questions asked while the agent is away are saved and
  re-queued on resume — the agent answers them first thing.
- **Persistence:** holes auto-save as JSON under `~/.rabbithole/`; resuming
  restores the doc, scroll position, mode, and canvas framing.

The MCP host stores each hole as a JSON file directly under `~/.rabbithole/`
(`RABBITHOLE_DIR` overrides the base directory) and assets under the matching
asset directory. The web `.rabbithole` file is the same persisted hole JSON
wrapped as `{ format: "rabbithole", format_version: 1, hole, assets }`, with
assets base64-encoded into the single JSON file for portability.

## Configuration

| Env var | Effect |
|---------|--------|
| `RABBITHOLE_DIR` | Override the storage directory (default `~/.rabbithole/`). |
| `RABBITHOLE_NO_BROWSER=1` | Don't auto-open the browser (headless/testing). |
| `RABBITHOLE_MAX_BLOCK_MS` | Max time for one blocking MCP wait before returning `keep_listening` (default `240000`). |

## Repo layout

- `bin/mcp-server.js` — entry point (stdio MCP server)
- `src/core/` — host-independent document engine, rendering, artifacts, and contracts
- `src/ui/` — shared live/frozen browser runtime
- `src/node/` — MCP host, filesystem storage, local HTTP/SSE, and PDF ingestion
- `src/web/` — static BYOK browser host and IndexedDB storage
- `dist/` — committed browser bundles used by GitHub `npx` installs
- `test/` — capability-oriented unit, contract, integration, end-to-end,
  performance, and packaging suites
- `workers/fetch-proxy/` — optional allowlisted URL-ingestion relay
- `website/public/` — public deployment assets consumed by `build:publish`

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and
[ARCHITECTURE.md](./ARCHITECTURE.md) for system boundaries. Compatibility,
testing, and interface rules live under [`docs/`](./docs/). The browser runtime
source lives in `src/ui/` and is bundled into committed artifacts under `dist/`.
When editing the UI, run:

```bash
npm run build
npm run check:dist
```

Commit both the source changes and `dist/`. There is no `prepare` build step;
GitHub `npx` installs use the committed artifacts.

## License

MIT
