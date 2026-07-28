import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** @param {Buffer | Uint8Array | string} value */
export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {import("node:stream").Readable} stream
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    /** @param {Buffer | Uint8Array | string} chunk */
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}

/** @param {string} filePath */
export function hashFile(filePath) {
  return hashStream(createReadStream(filePath));
}
