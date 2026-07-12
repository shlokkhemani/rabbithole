import { planPdfCrop } from "../core/pdf-shared.js";

export async function cropPdfAssetToDataUrl(blob, rect) {
  const canvas = await cropToCanvas(blob, rect);
  const result = await canvasToDataUrl(canvas);
  releaseCanvas(canvas);
  return result;
}

// Blob straight from the canvas — never fetch(data:), which the app's CSP blocks.
export async function cropPdfAssetToBlob(blob, rect) {
  const canvas = await cropToCanvas(blob, rect);
  const result = await canvasToBlob(canvas);
  releaseCanvas(canvas);
  return result;
}

async function cropToCanvas(blob, rect) {
  if (!blob) throw new Error("PDF page asset is missing.");
  const image = await decodeImage(blob);
  try {
    const plan = planPdfCrop(rect, image.width, image.height);
    if (!plan) throw new Error("PDF selection region is empty.");
    const canvas = createCanvas(plan.width, plan.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white"; context.fillRect(0, 0, plan.width, plan.height);
    context.drawImage(image, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
    return canvas;
  } finally { image.close?.(); }
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async"; image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}

function releaseCanvas(canvas) {
  try { canvas.width = 0; canvas.height = 0; } catch {}
}

async function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error("Canvas could not be encoded as JPEG.")); }, "image/jpeg", 0.85);
  });
}

async function canvasToDataUrl(canvas) {
  if (typeof canvas.convertToBlob === "function") return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
  return canvas.toDataURL("image/jpeg", 0.85);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
