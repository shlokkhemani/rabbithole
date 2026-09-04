#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function usage() {
  process.stderr.write("Usage: rabbithole <bridge [--port N] [--new-token] [--no-open] | mcp | --version>\n");
}

function parseBridgeArgs(args) {
  let port = 41414;
  let newToken = false;
  let autoOpen = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      if (index + 1 >= args.length) return null;
      port = Number(args[++index]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--new-token" && !newToken) {
      newToken = true;
    } else if (arg === "--no-open" && autoOpen) {
      autoOpen = false;
    } else {
      return null;
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { port, newToken, autoOpen };
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  await import("../src/node/mcp/server.js");
} else if ((command === "--version" || command === "-v") && args.length === 0) {
  // package.json is the single source of truth for the release version.
  process.stdout.write(`${require("../package.json").version}\n`);
} else if (command === "mcp" && args.length === 0) {
  await import("../src/node/mcp/server.js");
} else if (command === "bridge") {
  const options = parseBridgeArgs(args);
  if (!options) {
    usage();
    process.exitCode = 1;
  } else {
    const { runBridge } = await import("../src/node/bridge/index.js");
    await runBridge(options).catch((error) => {
      process.stderr.write(`rabbithole bridge: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
} else {
  usage();
  process.exitCode = 1;
}
