import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tiers = ["contracts", "integration", "e2e", "performance", "packaging"];
const metadataDirectories = [...tiers, "isolation-live"];
const failures = [];
for (const tier of metadataDirectories) {
  const directory = path.join(testDir, tier);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
    const file = path.join(directory, entry.name);
    const source = await fs.readFile(file, "utf8");
    if (!/^\/\*\* @protects [^\n]+ \*\//.test(source)) failures.push(`${tier}/${entry.name}: missing one-line @protects docblock`);
    if (tier === "e2e" && source.split("\n").length > 1_500) failures.push(`${tier}/${entry.name}: e2e entrypoint exceeds 1,500 lines`);
  }
}
const timings = JSON.parse(await fs.readFile(path.join(testDir, "timings.json"), "utf8"));
const e2eNames = (await fs.readdir(path.join(testDir, "e2e"))).filter((name) => name.endsWith(".test.mjs")).sort();
if (JSON.stringify(Object.keys(timings).sort()) !== JSON.stringify(e2eNames)) failures.push("timings.json must contain exactly every e2e test entrypoint");
if (failures.length) throw new Error(`suite purity failed:\n${failures.join("\n")}`);
process.stdout.write(`ok suite purity: ${metadataDirectories.length} checked directories, protected test metadata, bounded e2e entries, and measured sharding\n`);
