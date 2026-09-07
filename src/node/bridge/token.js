import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { bridgeDirectory } from "../shared/codex-home.js";

export { bridgeDirectory };

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export async function readOrCreateBridgeToken({
  env = process.env,
  regenerate = false,
} = {}) {
  const directory = bridgeDirectory(env);
  const tokenPath = path.join(directory, "bridge-token");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  if (!regenerate) {
    try {
      const token = (await fs.readFile(tokenPath, "utf8")).trim();
      if (TOKEN_PATTERN.test(token)) {
        await fs.chmod(tokenPath, 0o600);
        return { token, path: tokenPath, created: false };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  await fs.writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(tokenPath, 0o600);
  return { token, path: tokenPath, created: true };
}

export function tokenMatches(expected, authorization) {
  const prefix = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(prefix)) {
    return false;
  }
  const actual = authorization.slice(prefix.length);
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
