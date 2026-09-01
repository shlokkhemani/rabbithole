import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { systemClock } from "../../../core/clock.js";
import { warn } from "../../shared/logger.js";
import { shortId } from "../../shared/ids.js";

const PREFERENCES_VERSION = 1;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const mergeQueues = new Map();

function storeDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

function preferencePath() {
  return path.join(storeDir(), "preferences.json");
}

function lockPath() {
  return path.join(storeDir(), ".preferences.lock");
}

function emptyEnvelope() {
  return { version: PREFERENCES_VERSION, values: {} };
}

function parseEnvelope(raw) {
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    parsed.version !== PREFERENCES_VERSION ||
    !parsed.values ||
    typeof parsed.values !== "object" ||
    Array.isArray(parsed.values) ||
    Object.values(parsed.values).some((value) => typeof value !== "string")
  )
    throw new Error("preferences.json has an invalid v1 shape");
  return { version: PREFERENCES_VERSION, values: { ...parsed.values } };
}

async function readEnvelope() {
  try {
    return parseEnvelope(await fs.readFile(preferencePath(), "utf8"));
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "missing" : error?.message || String(error);
    warn("Reader preferences are unavailable (" + reason + "); using defaults until the next write.");
    return emptyEnvelope();
  }
}

export async function readPreferences() {
  const envelope = await readEnvelope();
  return { ...envelope.values };
}

async function acquireLock() {
  await fs.mkdir(storeDir(), { recursive: true });
  const started = systemClock.now();
  while (systemClock.now() - started < LOCK_TIMEOUT_MS) {
    try {
      return await fs.open(lockPath(), "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath());
        if (systemClock.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath(), { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out waiting to write reader preferences");
}

async function mergeLocked(patch) {
  const lock = await acquireLock();
  const finalPath = preferencePath();
  const temporary = finalPath + "." + shortId() + ".tmp";
  try {
    const envelope = await readEnvelope();
    Object.keys(patch).forEach(function (key) {
      const value = patch[key];
      if (value === null) delete envelope.values[key];
      else if (typeof value === "string") envelope.values[key] = value;
    });
    await fs.writeFile(temporary, JSON.stringify(envelope), "utf8");
    await fs.rename(temporary, finalPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(function () {});
    await lock.close().catch(function () {});
    await fs.rm(lockPath(), { force: true }).catch(function () {});
  }
}

export function mergePreferences(patch) {
  const file = preferencePath();
  const previous = mergeQueues.get(file) || Promise.resolve();
  const operation = previous.catch(function () {}).then(function () {
    return mergeLocked(patch && typeof patch === "object" ? patch : {});
  });
  mergeQueues.set(file, operation);
  return operation.finally(function () {
    if (mergeQueues.get(file) === operation) mergeQueues.delete(file);
  });
}
