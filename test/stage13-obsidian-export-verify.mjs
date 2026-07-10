import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Point storage at a scratch dir BEFORE importing the node host modules; the
// dir is read per-call, but keeping the order obvious costs nothing.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage13-"));
process.env.RABBITHOLE_DIR = path.join(tmpRoot, "holes");
delete process.env.RABBITHOLE_VAULT;

const { holeToVaultPlan, mergeCanvas, rewriteMarkdownForVault, slugify } = await import(
  "../src/core/canvas-export.js"
);
const { exportHoleToVault, readExportConfig, updateExportConfig } = await import(
  "../src/node/vault-export.js"
);

const HOLE_ID = "0f8b2c1d-aaaa-bbbb-cccc-121212121212";
const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const PENDING_ID = "33333333-3333-4333-8333-333333333333";

function nodeDefaults(overrides) {
  return {
    parent_id: null,
    title: "",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: false,
    created_at: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

function fixtureHole() {
  return {
    schema_version: 1,
    hole_id: HOLE_ID,
    title: "Gradient Descent: A Field Guide",
    root_id: ROOT_ID,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T10:05:00.000Z",
    view_state: null,
    nodes: [
      nodeDefaults({
        id: ROOT_ID,
        title: "Gradient Descent: A Field Guide",
        markdown:
          "# Gradient descent\n\nSee ![loss surface](asset:diagram-1.png) and the [spec](./spec.html).\n",
        base_url: "https://example.com/docs/guide.html",
        base_url_source: "explicit",
        position: { x: 0, y: 0 },
      }),
      nodeDefaults({
        id: CHILD_ID,
        parent_id: ROOT_ID,
        title: "Why learning rates explode",
        markdown: "Because step size outruns curvature.\n",
        origin: {
          selected_text: "step size",
          question: "Why would the learning rate explode?",
          lens: "deeper",
          anchor: { offset_start: 10, offset_end: 19 },
          branch_type: "selection",
        },
        position: { x: 700, y: 0 },
      }),
      nodeDefaults({
        id: PENDING_ID,
        parent_id: CHILD_ID,
        status: "pending",
        origin: {
          selected_text: "curvature",
          question: "What is curvature here?",
          lens: null,
          anchor: { offset_start: 30, offset_end: 39 },
          branch_type: "selection",
        },
        position: { x: 700, y: 600 },
      }),
    ],
  };
}

async function seedHole() {
  await fs.mkdir(process.env.RABBITHOLE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.RABBITHOLE_DIR, `${HOLE_ID}.json`),
    JSON.stringify(fixtureHole(), null, 2)
  );
  const assetDir = path.join(process.env.RABBITHOLE_DIR, "assets", HOLE_ID);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(path.join(assetDir, "diagram-1.png"), Buffer.from("89504e47", "hex"));
}

// ---- pure converter --------------------------------------------------------

assert.equal(slugify("Gradient Descent: A Field Guide"), "gradient-descent-a-field-guide");
assert.equal(slugify("  ***  "), "untitled");

{
  const rewritten = rewriteMarkdownForVault(
    "![loss](asset:diagram-1.png) and [spec](./spec.html) and [abs](https://a.b/c)",
    { baseUrl: "https://example.com/docs/guide.html", assetNames: ["diagram-1.png"] }
  );
  assert.match(rewritten, /!\[loss\]\(\.\.\/assets\/diagram-1\.png\)/, "asset ref becomes vault-relative");
  assert.match(rewritten, /\[spec\]\(https:\/\/example\.com\/docs\/spec\.html\)/, "relative link resolves");
  assert.match(rewritten, /\[abs\]\(https:\/\/a\.b\/c\)/, "absolute link untouched");
}

{
  const plan = holeToVaultPlan(fixtureHole(), { assetNames: ["diagram-1.png"] });
  assert.equal(plan.slug, "gradient-descent-a-field-guide");
  assert.equal(plan.canvasPath, `Rabbitholes/${plan.slug}/${plan.slug}.canvas`);

  // 2 doc file-nodes + 2 question cards (answered child + pending ask).
  const fileNodes = plan.canvas.nodes.filter((n) => n.type === "file");
  const textNodes = plan.canvas.nodes.filter((n) => n.type === "text");
  assert.equal(fileNodes.length, 2, "pending nodes must not produce notes");
  assert.equal(textNodes.length, 2);
  assert.equal(plan.notes.length, 2);

  const root = plan.canvas.nodes.find((n) => n.id === ROOT_ID);
  const child = plan.canvas.nodes.find((n) => n.id === CHILD_ID);
  const question = plan.canvas.nodes.find((n) => n.id === `q-${CHILD_ID}`);
  const pendingQuestion = plan.canvas.nodes.find((n) => n.id === `q-${PENDING_ID}`);
  // Default "caret" mode: documents stay unstamped (Caret reads them as
  // attached context; its chat lineage cannot read file nodes), questions are
  // user turns.
  assert.equal(root.role, undefined);
  assert.equal(child.role, undefined);
  assert.equal(question.role, "user");
  assert.match(question.text, /> step size/, "question card quotes the selection");
  assert.match(question.text, /Why would the learning rate explode\?/);
  assert.equal(question.rabbithole.anchor.offset_start, 10, "anchor preserved for round-trip");
  assert.ok(pendingQuestion, "pending ask still shows as a question card");

  // Edges: root -> q -> child, child -> q(pending); no edge into a missing answer.
  const edgeIds = plan.canvas.edges.map((e) => e.id).sort();
  assert.deepEqual(edgeIds, [`e-${CHILD_ID}`, `eq-${CHILD_ID}`, `eq-${PENDING_ID}`]);
  const lensEdge = plan.canvas.edges.find((e) => e.id === `eq-${CHILD_ID}`);
  assert.equal(lensEdge.label, "deeper");

  const rootNote = plan.notes.find((n) => n.nodeId === ROOT_ID);
  assert.match(rootNote.content, /^---\n/, "frontmatter present");
  assert.match(rootNote.content, /rabbithole_hole: "0f8b2c1d/);
  assert.match(rootNote.content, /..\/assets\/diagram-1\.png/);
  assert.deepEqual(plan.assets.map((a) => a.name), ["diagram-1.png"]);

  const chatMode = holeToVaultPlan(fixtureHole(), { roles: "chat" });
  assert.equal(chatMode.canvas.nodes.find((n) => n.id === ROOT_ID).role, "user");
  assert.equal(chatMode.canvas.nodes.find((n) => n.id === CHILD_ID).role, "assistant");
  assert.match(
    chatMode.notes.find((n) => n.nodeId === CHILD_ID).content,
    /role: "assistant"/,
    "chat mode stamps note frontmatter too"
  );

  const noRoles = holeToVaultPlan(fixtureHole(), { roles: "none" });
  assert.ok(noRoles.canvas.nodes.every((n) => n.role === undefined), 'roles: "none" leaves nodes unstamped');
  assert.throws(() => holeToVaultPlan(fixtureHole(), { roles: "bogus" }), /roles must be/);
}

// mergeCanvas: human geometry wins, foreign nodes/edges survive, our removed nodes drop.
{
  const fresh = {
    nodes: [
      { id: "a", type: "file", file: "x.md", x: 0, y: 0, width: 480, height: 440 },
      { id: "b", type: "text", text: "new", x: 10, y: 10, width: 320, height: 140 },
    ],
    edges: [{ id: "e-b", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
  };
  const existing = {
    nodes: [
      { id: "a", type: "file", file: "x.md", x: 999, y: -50, width: 200, height: 200, color: "4" },
      { id: "gone", type: "text", text: "we made this before", x: 0, y: 0, width: 1, height: 1 },
      { id: "human", type: "text", text: "human note", x: 5, y: 5, width: 100, height: 100 },
    ],
    edges: [{ id: "human-edge", fromNode: "human", toNode: "a" }],
  };
  const merged = mergeCanvas(fresh, existing, ["a", "gone"]);
  const a = merged.nodes.find((n) => n.id === "a");
  assert.equal(a.x, 999, "human-moved position preserved");
  assert.equal(a.color, "4", "human color preserved");
  assert.ok(!merged.nodes.some((n) => n.id === "gone"), "node we created, now gone from hole, is dropped");
  assert.ok(merged.nodes.some((n) => n.id === "human"), "foreign node kept");
  assert.ok(merged.edges.some((e) => e.id === "human-edge"), "foreign edge kept");
}

// ---- filesystem application ------------------------------------------------

await seedHole();
const vault = path.join(tmpRoot, "vault");
await fs.mkdir(vault, { recursive: true });

const first = await exportHoleToVault({ holeId: HOLE_ID, vaultPath: vault });
assert.equal(first.canvas_written, true);
assert.equal(first.notes_written.length, 2);
assert.equal(first.conflicts.length, 0);
assert.equal(first.assets_copied.length, 1);

const canvasFile = path.join(vault, first.canvas_path);
const canvas1 = JSON.parse(await fs.readFile(canvasFile, "utf-8"));
assert.equal(canvas1.nodes.filter((n) => n.type === "file").length, 2);
for (const node of canvas1.nodes.filter((n) => n.type === "file")) {
  const noteAbs = path.join(vault, node.file);
  const note = await fs.readFile(noteAbs, "utf-8");
  assert.match(note, /rabbithole_node:/);
}
const assetOnDisk = path.join(vault, "Rabbitholes", first.canvas_path.split("/")[1], "assets", "diagram-1.png");
await fs.access(assetOnDisk);

// vault_path is remembered.
assert.equal((await readExportConfig()).vault_path, vault);

// Re-export with nothing changed: pure no-op.
const second = await exportHoleToVault({ holeId: HOLE_ID });
assert.equal(second.canvas_written, false);
assert.equal(second.notes_written.length, 0);
assert.equal(second.notes_unchanged.length, 2);

// Human moves a node in Obsidian; sync must not fight them.
{
  const canvas = JSON.parse(await fs.readFile(canvasFile, "utf-8"));
  const child = canvas.nodes.find((n) => n.id === CHILD_ID);
  child.x = 4242;
  canvas.nodes.push({ id: "human-card", type: "text", text: "mine", x: 1, y: 1, width: 50, height: 50 });
  await fs.writeFile(canvasFile, JSON.stringify(canvas, null, "\t"));

  const after = await exportHoleToVault({ holeId: HOLE_ID });
  const canvasAfter = JSON.parse(await fs.readFile(canvasFile, "utf-8"));
  assert.equal(canvasAfter.nodes.find((n) => n.id === CHILD_ID).x, 4242, "human position wins on re-export");
  assert.ok(canvasAfter.nodes.some((n) => n.id === "human-card"), "human-added card survives sync");
  assert.equal(after.conflicts.length, 0);
}

// Human edits a note, then the hole changes too: conflict is reported, edit preserved.
{
  const canvas = JSON.parse(await fs.readFile(canvasFile, "utf-8"));
  const childNote = path.join(vault, canvas.nodes.find((n) => n.id === CHILD_ID).file);
  await fs.writeFile(childNote, "my own edits\n");

  const hole = fixtureHole();
  hole.nodes[1].markdown = "Updated answer body.\n";
  await fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${HOLE_ID}.json`), JSON.stringify(hole, null, 2));

  const result = await exportHoleToVault({ holeId: HOLE_ID });
  assert.equal(result.conflicts.length, 1, "edited note reports a conflict");
  assert.equal(await fs.readFile(childNote, "utf-8"), "my own edits\n", "human edit left untouched");
}

// A node deleted from the hole disappears from the canvas on the next sync.
{
  const hole = fixtureHole();
  hole.nodes = hole.nodes.filter((n) => n.id !== PENDING_ID);
  await fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${HOLE_ID}.json`), JSON.stringify(hole, null, 2));
  await exportHoleToVault({ holeId: HOLE_ID });
  const canvas = JSON.parse(await fs.readFile(canvasFile, "utf-8"));
  assert.ok(!canvas.nodes.some((n) => n.id === `q-${PENDING_ID}`), "removed ask leaves the canvas");
  assert.ok(canvas.nodes.some((n) => n.id === "human-card"), "human card still there after removal sync");
}

// Slug collision with a foreign folder gets a suffixed slug instead of clobbering.
{
  const otherId = "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000";
  const other = { ...fixtureHole(), hole_id: otherId };
  // Same title -> same base slug, but the existing canvas belongs to HOLE_ID.
  await fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${otherId}.json`), JSON.stringify(other, null, 2));
  const result = await exportHoleToVault({ holeId: otherId });
  assert.notEqual(result.canvas_path, first.canvas_path, "second hole with same title gets its own folder");
}

// Continuous flag plumbing.
await updateExportConfig({ continuous: true });
assert.equal((await readExportConfig()).continuous, true);

// CLI smoke: --list sees the seeded holes and exits 0.
{
  const { spawnSync } = await import("node:child_process");
  const cli = spawnSync(process.execPath, ["bin/export.js", "--list"], {
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Gradient Descent: A Field Guide/);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
process.stdout.write("stage13 obsidian export: all checks passed\n");
