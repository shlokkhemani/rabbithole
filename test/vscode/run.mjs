import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

await runTests({
  extensionDevelopmentPath: ROOT,
  extensionTestsPath: path.join(ROOT, "test/vscode/suite/index.cjs"),
  launchArgs: [
    "--disable-extensions",
    "--skip-welcome",
  ],
});
