import fs from "node:fs/promises";

/** Owns every transient PDF image created during one live session. */
export class SessionCrops {
  constructor() {
    this.regions = new Map();
    this.conversionPages = new Map();
  }

  holdRegion(requestId, filePath) {
    this.regions.set(requestId, filePath);
  }

  holdConversionPage(requestId, pageNumber, filePath) {
    let pages = this.conversionPages.get(requestId);
    if (!pages) {
      pages = new Map();
      this.conversionPages.set(requestId, pages);
    }
    pages.set(pageNumber, filePath);
  }

  hasPath(filePath) {
    if ([...this.regions.values()].includes(filePath)) return true;
    for (const pages of this.conversionPages.values()) {
      if ([...pages.values()].includes(filePath)) return true;
    }
    return false;
  }

  async releaseRegion(requestId) {
    const filePath = this.regions.get(requestId);
    if (!filePath) return;
    this.regions.delete(requestId);
    await unlink(filePath);
  }

  async releaseConversion(requestId) {
    const pages = this.conversionPages.get(requestId);
    if (!pages) return;
    this.conversionPages.delete(requestId);
    await Promise.all([...pages.values()].map(unlink));
  }

  async release(requestId) {
    await Promise.all([this.releaseRegion(requestId), this.releaseConversion(requestId)]);
  }

  async releaseAll() {
    const paths = [...this.regions.values()];
    for (const pages of this.conversionPages.values()) paths.push(...pages.values());
    this.regions.clear();
    this.conversionPages.clear();
    await Promise.all(paths.map(unlink));
  }
}

async function unlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
