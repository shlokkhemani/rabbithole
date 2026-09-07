import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function bridgeDirectory(env = process.env) {
  return env.RABBITHOLE_DIR
    || path.join(env.HOME || os.homedir(), ".rabbithole");
}

export function codexConfigToml({ suffix = "" } = {}) {
  return [
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    "",
    suffix ? suffix.trim() : "",
    "",
    "[features]",
    "# Required: otherwise Codex exposes the capable multi_agent_v1 tool.",
    "multi_agent = false",
    "",
    "[skills]",
    "include_instructions = false",
    "",
    "[skills.bundled]",
    "enabled = false",
    "",
    "[tools.experimental_request_user_input]",
    "enabled = false",
    "",
    "[orchestrator.skills]",
    "enabled = false",
    "",
    "[orchestrator.mcp]",
    "enabled = false",
    "",
  ].join("\n");
}

export async function prepareCodexHome({
  env = process.env,
  configSuffix = "",
  directoryName = "codex-home",
} = {}) {
  const directory = bridgeDirectory(env);
  const codexHome = path.join(directory, directoryName);
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const userAuthPath = path.join(env.HOME || os.homedir(), ".codex", "auth.json");

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.chmod(codexHome, 0o700);
  await fs.writeFile(configPath, codexConfigToml({ suffix: configSuffix }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600);

  let currentTarget;
  try {
    currentTarget = await fs.readlink(authPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EINVAL") throw error;
  }
  if (currentTarget !== userAuthPath) {
    await fs.unlink(authPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.symlink(userAuthPath, authPath);
  }
  return codexHome;
}
