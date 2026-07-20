#!/usr/bin/env node
/**
 * Export saved Rabbitholes into an Obsidian vault from the command line —
 * the batch/backfill companion to the export_to_obsidian MCP tool.
 *
 *   rabbithole-export --list
 *   rabbithole-export <hole_id> [--vault ~/vault] [--folder Rabbitholes]
 *   rabbithole-export --all --vault ~/vault
 *   rabbithole-export --continuous on|off
 *
 * This is a plain CLI (not an MCP server), so stdout is ours to print to.
 */

import { listRabbitholes, exportHoleToVault, readExportConfig, updateExportConfig } from "../src/node/index.js";

function usage() {
  process.stdout.write(
    [
      "Usage: rabbithole-export [hole_id ...] [options]",
      "",
      "Options:",
      "  --all                 Export every saved Rabbithole",
      "  --vault <path>        Obsidian vault path (remembered as the default)",
      "  --folder <name>       Vault-relative folder (default: Rabbitholes)",
      "  --roles <mode>        context (default) | turns | none — role annotations for AI-canvas plugins",
      "  --continuous on|off   Toggle auto-export on every future save",
      "  --list                List saved Rabbitholes with their ids",
      "  --help                Show this help",
      "",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = { holeIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--vault") args.vault = argv[++i];
    else if (arg === "--folder") args.folder = argv[++i];
    else if (arg === "--roles") args.roles = argv[++i];
    else if (arg === "--continuous") args.continuous = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else args.holeIds.push(arg);
  }
  if (args.continuous !== undefined && !["on", "off"].includes(args.continuous)) {
    throw new Error('--continuous takes "on" or "off"');
  }
  return args;
}

function formatSummary(summary) {
  const lines = [`${summary.title || summary.hole_id} -> ${summary.canvas_path}`];
  lines.push(
    `  notes: ${summary.notes_written.length} written, ${summary.notes_unchanged.length} unchanged` +
      (summary.assets_copied.length ? `; assets: ${summary.assets_copied.length} copied` : "")
  );
  for (const conflictPath of summary.conflicts) {
    lines.push(`  conflict (edited in vault, left untouched): ${conflictPath}`);
  }
  return lines.join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    usage();
    process.exit(2);
  }

  if (args.help) {
    usage();
    return;
  }

  if (args.list) {
    const { holes } = await listRabbitholes();
    if (!holes.length) {
      process.stdout.write("No saved Rabbitholes.\n");
      return;
    }
    for (const hole of holes) {
      process.stdout.write(`${hole.hole_id}  ${hole.updated_at}  ${hole.node_count} nodes  ${hole.title}\n`);
    }
    return;
  }

  if (args.continuous !== undefined && !args.all && args.holeIds.length === 0) {
    const updated = await updateExportConfig({ continuous: args.continuous === "on" });
    process.stdout.write(
      `Continuous vault sync ${updated.continuous ? "on" : "off"}` +
        (updated.vault_path ? ` (vault: ${updated.vault_path})\n` : " — set a vault with --vault on your next export\n")
    );
    return;
  }

  let holeIds = args.holeIds;
  if (args.all) {
    const { holes } = await listRabbitholes();
    holeIds = holes.map((hole) => hole.hole_id);
  }
  if (!holeIds.length) {
    usage();
    const config = await readExportConfig();
    if (config.vault_path) {
      process.stdout.write(`Configured vault: ${config.vault_path} (continuous: ${config.continuous ? "on" : "off"})\n`);
    }
    process.exit(2);
  }

  let failures = 0;
  for (const holeId of holeIds) {
    try {
      const summary = await exportHoleToVault({
        holeId,
        vaultPath: args.vault,
        folder: args.folder,
        roles: args.roles,
        continuous: args.continuous === undefined ? undefined : args.continuous === "on",
      });
      process.stdout.write(`${formatSummary(summary)}\n`);
    } catch (err) {
      failures += 1;
      process.stderr.write(`Failed to export ${holeId}: ${err.message}\n`);
    }
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
