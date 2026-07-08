# Rabbithole

**An infinite canvas for learning.** Open a document, select any text, ask a
question — and the answer opens as a fully-rendered child document. Recurse as
deep as you like. Every hole is saved and revisitable.

Rabbithole is an MCP server. Your terminal agent (Claude Code, Codex, or any
MCP client) does the answering; Rabbithole gives it a canvas in your browser.
Everything runs locally — no account, no API keys, nothing leaves your machine.

🌐 **[rabbithole.ing](https://rabbithole.ing)**

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
3. **Verify**: after the client reconnects, four tools should be available —
   `open_rabbithole`, `answer_branch`, `ingest_pdf`, `list_rabbitholes`. (In Claude Code,
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
| `open_rabbithole` | Open a doc (`{ title, content }` / `{ title, file_path }`, optional `base_url`, optional `assets`, optional `ingest_id`) or resume one (`{ hole_id }`). Opens the canvas in the browser and blocks until the human asks something. |
| `answer_branch` | Answer a pending branch request → a child document. Stream with `partial: true` chunks, then finish with a normal call carrying the node title; use `base_url` for fetched markdown and `assets` for local images referenced as `asset:name.png`. |
| `ingest_pdf` | Extract a local PDF into page PNGs (`page-001.png`...), opportunistic embedded rasters (`embed-p001-01.png`...), metadata, and per-page text. Author the markdown yourself, reference returned asset names with `asset:`, then pass `ingest_id` to `open_rabbithole`; or pass `hole_id` to ingest directly into an existing hole. |
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
  selections become inline marks (pending → ready); hover a ready mark for a
  peek preview; child docs carry a FROM strip that jumps back to the exact origin.
- **Streamed answers:** words appear live with a breathing caret — in the
  reader, the thread, and the canvas card.
- **Rich Markdown:** answers can use math, highlighted language code fences,
  `show` diagrams, URL-based resolution for relative links/images, and local
  image assets via `asset:name.png`; source stays as Markdown for copy/export,
  while frozen snapshots inline assets into the HTML.
- **Lenses:** one-tap presets on the ask popup — Explain · ELI5 · Example ·
  Go Deeper (keys 1–4).
- **Follow-up chat:** a composer under each document asks about the doc as a
  whole; answers render inline and are branchable like any other text.
- **Canvas mode:** infinite pan/zoom, draggable/resizable cards, edges that
  attach to the exact selected text in the parent, collapse, auto-layout.
- **Navigation:** `j`/`k` walk marks, `↵` opens, `⌫` jumps back up, `⌘K` searches
  the whole hole.
- **Share/export:** copy any trail or document as Markdown, download a frozen
  single-file snapshot, or ask the agent for a synthesis of the whole journey.
- **Durable asks:** questions asked while the agent is away are saved and
  re-queued on resume — the agent answers them first thing.
- **Persistence:** holes auto-save as JSON under `~/.rabbithole/`; resuming
  restores the doc, scroll position, mode, and canvas framing.

## Configuration

| Env var | Effect |
|---------|--------|
| `RABBITHOLE_DIR` | Override the storage directory (default `~/.rabbithole/`). |
| `RABBITHOLE_NO_BROWSER=1` | Don't auto-open the browser (headless/testing). |
| `RABBITHOLE_MAX_BLOCK_MS` | Max time for one blocking MCP wait before returning `keep_listening` (default `240000`). |

## Repo layout

- `bin/mcp-server.js` — entry point (stdio MCP server)
- `src/` — server, canvas UI (self-contained HTML), storage
- `website/` — [rabbithole.ing](https://rabbithole.ing), a Next.js single-page site

## Development

The browser runtime source lives in `src/ui/` and is bundled into committed
artifacts under `dist/`. When editing the UI, run:

```bash
npm run build
npm run check:dist
```

Commit both the source changes and `dist/`. There is no `prepare` build step;
GitHub `npx` installs use the committed artifacts.

## License

MIT
