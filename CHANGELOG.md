# Changelog

Notable changes to Rabbithole, newest first. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and a `0.MINOR.PATCH`
scheme: releases are tagged `vX.Y.Z`, and public copy names the minor only
("Rabbithole v0.4").

## v0.4.0 (unreleased)

> **Draft.** Assembled from `main` since v0.3.0 for the maintainer to cut down
> and rewrite before release.

### Added

- Use the Claude Code or Codex subscription already signed in on your machine instead of an API key: `npx @shlokkhemani/rabbithole bridge` pairs the web app with the local CLI over loopback.
- Margin notes: annotate any passage in place, read and edit notes in a popover, promote a note to a card, or turn a note into an ask.
- Every card gets a `⋯` menu with text size, note→ask, and branch actions.
- Bring any OpenAI-compatible endpoint, including one on your local network, as a provider.
- React to a selection with 👍 or 👎, and edit the quick questions offered above a selection.
- A settings sheet with global theme and reading-scale preferences that persist through the host across origins.
- Auto-tidy folds branches you have read and moved on from, so the canvas stays legible as it grows.
- Pin cards as standalone windows that float above the canvas and stay fully interactive.
- Mermaid diagrams render inline, open fullscreen, and can be asked about like any other passage.
- A dedicated PDF reader workspace: full-viewport pages, a persistent branch rail, and selections aligned to real glyph geometry.
- Canvas is home everywhere — the reader is the maximized card, reached by an anchored zoom.
- Paste images into notes and asks, copy any code block, and scroll the canvas by dragging to its edge.
- Delegated sub-agent branches, so an agent can hand a branch to a sub-agent and stream the answer back.
- Ask an agent to draw or illustrate something and the picture lands in the card: `generate_image` runs the Codex CLI's built-in image generation on your ChatGPT plan, and follow-up asks can edit the picture.
- Rabbithole is published to npm as `@shlokkhemani/rabbithole`.

### Changed

- The MCP thread carries only lineage the agent has not already been sent, bounded by a budget, with a canvas map, delta notes, and `read_rabbithole` for anything omitted.
- The blocked agent call is the one durable listener: progress keepalives hold it open, sessions survive reconnects, and there is no idle timeout.
- Queued asks show a "Waiting for previous answer" card state instead of appearing to hang.
- Fold rows carry mini-tree glyphs where a filled node is a folded node.
- `list_rabbitholes` is bounded and searchable, and hole ids are short.
- Faster startup, batched browser storage, and a smaller hosted bundle.
- The synthesize-journey feature was removed.

### Fixed

- Ollama restart instructions, mobile canvas gestures, reduced-motion composer, and a long tail of contributor-reported canvas and settings bugs.
- The OpenRouter key no longer vanishes between visits, and `www` canonicalizes to the apex host.
- Pinned `fast-uri` 3.1.3 for CVE-2026-13676.

## v0.3.0 — 2026-07-14

- Upgraded PDF learning experience.
- Now also on the web!
- Bring your own key, or run it entirely on local models.
- Free and fully open source.
- The canvas-first web app ships at [rabbithole.ing](https://rabbithole.ing) — holes are files in a rail, documents live in your browser.
- OpenRouter BYOK, or point Rabbithole at Ollama and keep every token on your machine.
- PDFs open natively: select real text, clip a figure, and convert to a document only when you ask.
- Open a URL or an arXiv link directly through the hosted fetch relay.
- A guided recovery path when a local model endpoint is unreachable.

## v0.2.0 — 2026-07-08

- LaTeX math and diagrams render on the canvas.
- `ingest_pdf` opens research papers directly in Rabbithole.
- Images are first-class: per-hole assets, inline resize, a lightbox, and a dark-mode matte for diagrams.
- Relative links and images in Markdown resolve against the document's source URL.
- Fixed agent-listening timeouts — the listener rearms, re-attaches live, and keeps a grace window, so asks survive a dropped connection.

## v0.1.0 — 2026-07-05

- Initial launch: an infinite canvas for learning. Open a document, select any passage, ask, and the answer arrives as a child card you can branch from again.
- An MCP server (`open_rabbithole`, `answer_branch`, `list_rabbitholes`) lets Claude Code, Codex, and any MCP client answer while the canvas stays on your machine.
- Local-first by construction: holes are saved under `~/.rabbithole`, with no account, no telemetry, and no hosted document store.
- A reader for the current document, a command palette, and follow-up asks on any card.
