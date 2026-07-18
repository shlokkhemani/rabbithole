import fs from "node:fs/promises";
import path from "node:path";
import { PDF_CROP_IMAGE_QUALITY, planPdfCrop } from "../core/pdf-shared.js";
import { ensureAssetDir, resolveAsset } from "./fs-store.js";

export async function cropPdfRegionToFile({ holeId, asset, rect, requestId }) {
  const source = await resolveAsset(holeId, asset);
  if (!source) throw new Error("PDF page asset is missing.");
  const canvas = await import("@napi-rs/canvas").catch((error) => { throw new Error(`PDF crop support is unavailable: ${error.message}`); });
  const image = await canvas.loadImage(source);
  const plan = planPdfCrop(rect, image.width, image.height);
  if (!plan) throw new Error("PDF selection region is empty.");
  const surface = canvas.createCanvas(plan.width, plan.height);
  const context = surface.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, plan.width, plan.height);
  context.drawImage(image, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
  const safeRequest = String(requestId || "selection").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "selection";
  const filePath = path.join(await ensureAssetDir(holeId), `region-${safeRequest}.jpg`);
  await fs.writeFile(filePath, surface.toBuffer("image/jpeg", PDF_CROP_IMAGE_QUALITY * 100));
  surface.width = 0; surface.height = 0;
  return filePath;
}

// Region crops are transient agent-facing files, not durable hole assets.
// A crashed or superseded session can leave them behind; a resume sweeps the
// directory before writing its own.
export async function sweepPdfRegionFiles(holeId) {
  const dir = await ensureAssetDir(holeId);
  const entries = await fs.readdir(dir).catch(() => []);
  await Promise.all(entries
    .filter((name) => /^region-[A-Za-z0-9_-]+\.jpg$/.test(name))
    .map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
}

export async function cropPdfFigureToAsset({ holeId, asset, rect, name }) {
  const source = await resolveAsset(holeId, asset);
  const canvas = await import("@napi-rs/canvas"); const image = await canvas.loadImage(source);
  const plan = planPdfCrop(rect, image.width, image.height); if (!plan) throw new Error("PDF figure region is empty.");
  const surface = canvas.createCanvas(plan.width, plan.height), context = surface.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, plan.width, plan.height); context.drawImage(image, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
  const buffer = surface.toBuffer("image/jpeg", PDF_CROP_IMAGE_QUALITY * 100);
  const filePath = path.join(await ensureAssetDir(holeId), name); await fs.writeFile(filePath, buffer); surface.width = 0; surface.height = 0;
  return { filePath, bytes: buffer.length };
}

/** Durable branch-owned crop; kept separate from transient region-* files. */
export async function cropPdfRegionToAsset({ holeId, asset, rect, name }) {
  return cropPdfFigureToAsset({ holeId, asset, rect, name });
}
