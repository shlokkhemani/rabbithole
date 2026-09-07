# Rabbithole

An infinite canvas for learning. Open a document, ask at any point, and follow each answer into a new document.

[![Rabbithole branching canvas demo](website/public/demo-ask-poster.jpg)](https://rabbithole.ing)

**[Open the web app](https://rabbithole.ing)** · **[Explore the offline architecture tour](docs/tour.html)**

Rabbithole has two hosts and one canvas:

- The static web app uses your chosen model endpoint or the coding-agent subscription already signed in on your machine.
- The MCP server lets Claude Code, Codex, and other MCP clients answer while the canvas, storage, and local transport stay on your machine.

No account, telemetry, or hosted document store. Web documents live in your browser. MCP documents live under `~/.rabbithole/` unless `RABBITHOLE_DIR` overrides it.

## Web

Visit [rabbithole.ing](https://rabbithole.ing), then paste a question or URL, drop Markdown or PDF, or import a Rabbithole file.

The web app supports OpenRouter, local and custom OpenAI-compatible endpoints, and the optional subscription bridge:

```bash
npx @shlokkhemani/rabbithole bridge
```

The bridge prints a private pairing link and connects the page to an installed, signed-in Claude Code or Codex CLI. It binds only to loopback.

## MCP quick start

Requires Node 18+ and a browser.

Claude Code:

```bash
claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

Codex:

```bash
codex mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole
```

Then start a fresh agent session and say:

> Open this document in Rabbithole.

The tool call stays pending while the agent listens for canvas asks. If a client enforces a short MCP tool timeout, raise that client's timeout; saved asks survive disconnects and resume.

## Develop

```bash
git clone https://github.com/shlokkhemani/rabbithole.git
cd rabbithole
npm install
npm run build
npm test
```

Useful references:

- [Product and architecture tour](docs/01-tour.md)
- [Generated module map](docs/generated/module-map.md)
- [Generated command map](docs/generated/commands.md)
- [Testing model](docs/05-contribute.md)
- [Compatibility contract](docs/compatibility.md)
- [Design system](docs/design-system.md)
- [Historical proposals](docs/proposals/README.md)

The canvas and frozen snapshots remain self-contained HTML. Package tarballs include the browser bundles built during packaging, so registry installs need no consumer-side build.

## License

MIT. See [LICENSE](LICENSE).
