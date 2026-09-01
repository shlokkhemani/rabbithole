import { MAX_ASSET_BYTES } from "../core/assets.js";
import { shortId } from "../core/utils.js";

export const CLIPBOARD_IMAGE_MAX_LONG_EDGE = 2048;
export const CLIPBOARD_IMAGE_PNG_REENCODE_BYTES = 3 * 1024 * 1024;
export const CLIPBOARD_IMAGE_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);

/** @param {number} width @param {number} height @param {number} [maxLongEdge] */
export function normalizedImageDimensions(width, height, maxLongEdge = CLIPBOARD_IMAGE_MAX_LONG_EDGE) {
  width = Math.max(1, Math.round(Number(width) || 1));
  height = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    downscaled: scale < 1,
  };
}

/** @param {unknown} sourceType @param {number} [encodedBytes] */
export function clipboardImageOutput(sourceType, encodedBytes = 0) {
  const jpeg =
    String(sourceType || "").toLowerCase() === "image/jpeg" ||
    Number(encodedBytes) > CLIPBOARD_IMAGE_PNG_REENCODE_BYTES;
  return jpeg
    ? { type: "image/jpeg", extension: "jpg", quality: 0.9 }
    : { type: "image/png", extension: "png", quality: undefined };
}

/** @param {number} encodedBytes */
export function clipboardImageSizeErrorCode(encodedBytes) {
  if (Number(encodedBytes) > MAX_ASSET_BYTES) return "asset_too_large";
  if (Number(encodedBytes) > CLIPBOARD_IMAGE_MAX_BYTES) return "clipboard_image_too_large";
  return null;
}

/** @param {unknown} sourceType @param {() => string} [mintId] */
export function createPastedImageName(sourceType, mintId = shortId) {
  return `paste-${mintId()}.${clipboardImageOutput(sourceType).extension}`;
}

/** @param {Blob} source */
export async function normalizeClipboardImage(source) {
  if (
    !(source instanceof Blob) ||
    !String(source.type || "")
      .toLowerCase()
      .startsWith("image/")
  ) {
    throw new Error("Clipboard item is not an image.");
  }
  const decoded = await decodeImage(source);
  try {
    const size = normalizedImageDimensions(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.drawImage(decoded.image, 0, 0, size.width, size.height);
      let output = clipboardImageOutput(source.type);
      let blob = await encodeCanvas(canvas, output);
      const fallback = clipboardImageOutput(output.type, blob.size);
      if (fallback.type !== output.type) {
        output = fallback;
        blob = await encodeCanvas(canvas, output);
      }
      const sizeError = clipboardImageSizeErrorCode(blob.size);
      if (sizeError) {
        const error = Object.assign(
          new Error(sizeError === "asset_too_large" ? "Pasted image exceeds 20 MB." : "Pasted image is too large."),
          { code: sizeError },
        );
        throw error;
      }
      return { name: createPastedImageName(output.type), blob, width: size.width, height: size.height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    decoded.release();
  }
}

/** @param {HTMLCanvasElement} canvas @param {{type: string, quality?: number}} output */
function encodeCanvas(canvas, output) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Clipboard image could not be encoded."))),
      output.type,
      output.quality,
    ),
  );
}

/** @param {Blob} source */
async function decodeImage(source) {
  const url = URL.createObjectURL(source);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: function () {
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
