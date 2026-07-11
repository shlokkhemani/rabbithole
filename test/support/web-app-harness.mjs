import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ensureWebDist } from "./build.mjs";
import { serveStatic } from "./static-server.mjs";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
export const WEB_DIST = path.join(ROOT, "web/dist");

export async function bootWebApp() {
  try {
    await fs.access(path.join(WEB_DIST, "index.html"));
  } catch {
    ensureWebDist();
  }
  const server = await serveStatic(WEB_DIST);
  const browser = await chromium.launch();
  return {
    browser,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
