# Rabbithole

**An infinite canvas for learning.** Open a document, select any text, ask a
question — and the answer opens as a fully-rendered child document. Follow
whatever pulls at you, as deep as it goes. Every hole is saved and
revisitable.

🌐 **[rabbithole.ing](https://rabbithole.ing)**

There are two ways in:

- **The web app** — [rabbithole.ing](https://rabbithole.ing). Bring an
  OpenRouter key or point it at a local model. Static site, no account, no
  backend: your key stays in your browser, and so do your documents.
- **The MCP server** — for terminal agents. Claude Code, Codex, or any MCP
  client does the answering; Rabbithole gives it a canvas in your browser.
  The server, storage, and canvas all run on your machine — your documents
  and questions go only to the agent you already use.

## Use it on the web

Open **[rabbithole.ing](https://rabbithole.ing)** and start from anywhere:
drop in a PDF or Markdown file, paste a URL, import a `.rabbithole` or
snapshot `.html` — or just ask a question and let the answer become your
first document.

Two ways to run a model:

- **OpenRouter** (recommended) — one key, every major model. The model picker
  pulls OpenRouter's live catalog.
- **Local** — any OpenAI-compatible endpoint: Ollama, LM Studio, llama.cpp.
  No key required.

Keys never leave the browser: they're stored locally (or session-only, your
choice) and sent exclusively to the provider origin you configure. Exports
scrub anything credential-shaped.

### Run the browser version locally

Requires Node 18+:

```bash
git clone https://github.com/shlokkhemani/rabbithole.git
cd rabbithole
npm install
npm run build
npx -y serve web/dist
```

Open **[http://localhost:3000](http://localhost:3000)** (or the URL printed by
`serve`). The local browser build has the same OpenRouter and
OpenAI-compatible local-model options as [rabbithole.ing](https://rabbithole.ing),
and its documents and provider settings stay in that browser's local storage.

Holes persist in IndexedDB, and each document gets a memorable local URL such
as `rabbithole.ing/curious-teacup-abcdef`. That path names a record in *your*
browser's database — it is not a sharing link. To move a hole between
machines, export the `.rabbithole` file; to share something readable,
download a snapshot.

Self-hosting is static: run `npm run build` and serve `web/dist` from any
host. The optional `workers/fetch-proxy` Cloudflare Worker enables URL
ingestion for sources that block browser CORS (set `RABBITHOLE_PROXY_URL` at
build time to point the app at your relay). Serve `index.html` as the
fallback for unknown single-segment paths so document URLs survive a direct
visit or refresh.

## Quick start

Requires Node 18+ and a browser. Pick your agent:

**Claude Code**

```bash
claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

**Codex**

```bash
codex mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

Then raise the tool timeout in `~/.codex/config.toml` — Codex's 60-second
default is shorter than Rabbithole's blocking wait, and `codex mcp add`
cannot set this field:

```toml
[mcp_servers.rabbithole]
command = "npx"
args = ["-y", "github:shlokkhemani/rabbithole"]
tool_timeout_sec = 600
```

**Any other MCP client** — most accept this shape in their MCP config:

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

If a host ever reports a tool timeout, nothing is lost — questions are saved
and re-queued the next time the agent listens.

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
a hang. The first `npx` run fetches this repo, so allow it time; later runs
are cached. If the browser must not auto-open (headless), set
`RABBITHOLE_NO_BROWSER=1` in the server's env.

## Tools

| Tool | What it does |
|------|--------------|
| `open_rabbithole` | Open a doc (`{ title, content }` / `{ title, file_path }`, optional `base_url`, optional `assets`, optional `ingest_id`) or resume one (`{ hole_id }`). Opens the canvas in the browser and blocks until the human asks something. |
| `answer_branch` | Answer a pending branch request → a child document. Stream with `partial: true` chunks, then finish with a normal call carrying the node title; use `base_url` for fetched markdown and `assets` for local images referenced as `asset:name.png`. |
| `ingest_pdf` | Extract a local PDF into page PNGs (`page-001.png`...), opportunistic embedded rasters (`embed-p001-01.png`...), metadata, and per-page text. Author the markdown yourself, reference returned asset names with `asset:`, then pass `ingest_id` to `open_rabbithole`; or pass `hole_id` to ingest directly into an existing hole. |
| `export_to_obsidian` | Export a saved hole into an Obsidian vault as a JSON Canvas plus one markdown note per document — vault-native, crosslinkable knowledge. Re-exporting syncs instead of clobbering; pass `continuous: true` to auto-export on every save. |
| `list_rabbitholes` | List saved holes to resume by id. |

The loop: `open_rabbithole` → `branch_request` → `answer_branch` → `branch_request` → … → `session_closed`.
Long waits may return `keep_listening`; immediately call `open_rabbithole`
again with the returned `hole_id`. If the host reports a tool timeout, do the
same — questions are saved.

For research PDFs, page renders are the dependable figure source. For arXiv
links, prefer fetching the HTML version and opening that content with
`base_url` instead of ingesting the PDF.

## What's inside

- **Reader mode (default):** fullscreen reading, branches sidebar, breadcrumbs;
  selections become inline marks (pending → ready); clicking a mark jumps to
  its answer; child docs carry a FROM strip that jumps back to the exact origin.
- **Streamed answers:** words appear live with a breathing caret — in the
  reader, the thread, and the canvas card.
- **Rich Markdown:** answers can use math, highlighted language code fences,
  standard `mermaid` diagrams, bespoke `show` visuals, URL-based resolution
  for relative links/images, and local image assets via `asset:name.png`;
  source stays as Markdown for copy/export,
  while frozen snapshots inline assets into the HTML.
- **Interactive checks:** answer multiple-choice questions inline; progress
  survives reloads and portable backups, while shared snapshots start clean.
- **Lenses:** one-tap presets on the ask popup — Explain · ELI5 · Example ·
  Go Deeper (keys 1–4).
- **Follow-up chat:** a composer under each document asks about the doc as a
  whole; answers render inline and are branchable like any other text.
- **Canvas mode:** infinite pan/zoom, draggable/resizable cards, edges that
  attach to the exact selected text in the parent, collapse, auto-layout.
- **Navigation:** `j`/`k` walk marks, `↵` opens, `⌫` jumps back up, `⌘K`
  searches the whole hole.
- **Share/export:** copy any trail or document as Markdown; **Download
  snapshot** produces a single self-contained `.html` — data, assets, and a
  read-only client in one file anyone can open; **Export Rabbithole** (web
  app) produces a `.rabbithole` backup for device transfer — MCP holes are
  already plain JSON on disk; or ask the agent for a synthesis of the whole
  journey.
- **Durable asks:** questions asked while the agent is away are saved and
  re-queued on resume — the agent answers them first thing.
- **Persistence:** holes auto-save as JSON under `~/.rabbithole/`; resuming
  restores the doc, scroll position, mode, and canvas framing.

The MCP host stores each hole as a JSON file directly under `~/.rabbithole/`
(`RABBITHOLE_DIR` overrides the base directory) and assets under the matching
asset directory. The web `.rabbithole` file is the same persisted hole JSON
wrapped as `{ format: "rabbithole", format_version: 1, hole, assets }`, with
assets base64-encoded into the single JSON file for portability.

## Export to Obsidian

Go down rabbit holes for spontaneous research, then bake the results into your
vault where they can be crosslinked and referred to. Each hole exports as a
folder: a `.canvas` file wiring together one markdown note per document, plus
question cards and the hole's image assets. Notes carry frontmatter provenance
(`rabbithole_hole`, `rabbithole_node`, the question, the lens), so everything
is searchable, wiki-linkable, and shows up in the graph like any other note.
Question cards also carry conversation-role annotations that AI-canvas plugins
can read (invisible in native Obsidian; the default shape was verified to keep
conversations continuable in the Caret plugin).

```bash
# ask your agent:  "export this rabbithole to my vault"
# or from the terminal:
npx -p github:shlokkhemani/rabbithole rabbithole-export --list
npx -p github:shlokkhemani/rabbithole rabbithole-export <hole_id> --vault ~/Vault
npx -p github:shlokkhemani/rabbithole rabbithole-export --all            # backfill everything
npx -p github:shlokkhemani/rabbithole rabbithole-export --continuous on  # auto-export on every save
```

The vault path is remembered after the first export (`RABBITHOLE_VAULT`
overrides). Re-exporting the same hole is a sync, not a clobber: node
positions you set in Obsidian win, notes you edited in the vault are left
untouched (reported as conflicts), and cards you added yourself survive. With
continuous sync on, every save of any hole re-exports it a couple of seconds
later, so the vault quietly tracks your live rabbitholes.

## Configuration

| Env var | Effect |
|---------|--------|
| `RABBITHOLE_DIR` | Override the storage directory (default `~/.rabbithole/`). |
| `RABBITHOLE_NO_BROWSER=1` | Don't auto-open the browser (headless/testing). |
| `RABBITHOLE_VAULT` | Obsidian vault path for `rabbithole-export` / `export_to_obsidian` (overrides the remembered default). |
| `RABBITHOLE_MAX_BLOCK_MS` | Max time for one blocking MCP wait before returning `keep_listening` (default `240000`). |
| `RABBITHOLE_PROXY_URL` | Build-time: URL of your fetch-proxy relay for the web app (empty string disables the default). |

## Repo layout

- `bin/mcp-server.js` — entry point (stdio MCP server)
- `src/core/` — host-independent document engine, rendering, artifacts, and contracts
- `src/ui/` — shared live/frozen browser runtime
- `src/node/` — MCP host, filesystem storage, local HTTP/SSE, and PDF ingestion
- `src/web/` — static BYOK browser host and IndexedDB storage
- `build.mjs` — builds the committed MCP bundles and the static web app
- `dist/` — committed browser bundles used by GitHub `npx` installs
- `web/dist/` — generated static web app (untracked build output)
- `scripts/` — reproducibility checks and publish assembly
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

### Production deployment

The [`Deploy Cloudflare Pages`](./.github/workflows/deploy-pages.yml) workflow
runs the complete test suite and deploys `publish/` to the `rabbithole` Pages
project on every push to `main`. It can also be rerun manually from GitHub
Actions. Each Cloudflare deployment is tagged with the exact Git commit.

The workflow requires:

- repository variable `CLOUDFLARE_ACCOUNT_ID`;
- repository secret `CLOUDFLARE_API_TOKEN`, scoped to **Account → Cloudflare
  Pages → Edit**.

Configure them with `gh variable set CLOUDFLARE_ACCOUNT_ID` and `gh secret set
CLOUDFLARE_API_TOKEN`; both commands prompt without committing credentials.

## License

MIT
