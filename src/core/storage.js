import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { warn } from "./logger.js";

/**
 * Holes are persisted one JSON file per hole under ~/.rabbithole/.
 * Answered nodes are stored in full; pending nodes are stored as durable asks
 * (question + anchor, empty markdown) so a resume can re-queue them for the
 * agent. Rendered HTML is recomputed on load.
 */

function holesDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

async function ensureDir() {
  const dir = holesDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * hole_id reaches storage from the agent (open_rabbithole) and from persisted
 * files, so it must never be allowed to escape the storage dir via "../" or an
 * absolute path. Allow only the id shapes we actually mint (UUIDs / slugs).
 */
function assertSafeHoleId(holeId) {
  const id = String(holeId ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid hole id: ${JSON.stringify(holeId)}`);
  }
  return id;
}

function holePath(holeId) {
  return path.join(holesDir(), `${assertSafeHoleId(holeId)}.json`);
}

/**
 * @param {{ hole_id, title, root_id, created_at, nodes: object[] }} hole
 */
export async function saveHole(hole) {
  await ensureDir();
  const persisted = {
    hole_id: hole.hole_id,
    title: hole.title,
    root_id: hole.root_id,
    created_at: hole.created_at,
    updated_at: new Date().toISOString(),
    // Where the human last was (mode, node, scroll, canvas transform) — restored
    // on reopen so a resume lands exactly where they left off.
    view_state: hole.view_state ?? null,
    nodes: hole.nodes.map((node) => ({
      id: node.id,
      parent_id: node.parent_id ?? null,
      title: node.title ?? "",
      markdown: node.markdown ?? "",
      base_url: node.base_url ?? null,
      origin: node.origin ?? null,
      position: node.position ?? { x: 0, y: 0 },
      size: node.size ?? null,
      font_scale: node.font_scale ?? 1,
      collapsed: !!node.collapsed,
      status: node.status === "pending" ? "pending" : "answered",
      // Whether the human has opened this answer — unread answers get a dot and
      // feed the "since you left" count on the next open.
      read: !!node.read,
      created_at: node.created_at ?? null,
    })),
  };
  // Unique temp name per write so concurrent/overlapping saves of the same hole
  // never clobber each other's temp file mid-write; rename is atomic, last wins.
  const finalPath = holePath(hole.hole_id);
  const tmp = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), "utf-8");
    await fs.rename(tmp, finalPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return persisted;
}

export async function loadHole(holeId) {
  const raw = await fs.readFile(holePath(holeId), "utf-8");
  return JSON.parse(raw);
}

export async function listHoles() {
  let entries;
  try {
    entries = await fs.readdir(holesDir());
  } catch {
    return [];
  }

  const holes = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(holesDir(), name), "utf-8");
      const hole = JSON.parse(raw);
      holes.push({
        hole_id: hole.hole_id,
        title: hole.title,
        updated_at: hole.updated_at,
        node_count: Array.isArray(hole.nodes) ? hole.nodes.length : 0,
      });
    } catch (err) {
      warn(`Skipping unreadable hole ${name}: ${err.message}`);
    }
  }
  holes.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return holes;
}
