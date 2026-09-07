import { readPreferences } from "./store/prefs-store.js";

export const AI_IMAGES_PREF_KEY = "rh-ai-images";

export function imagesEnabled(values) {
  return values?.[AI_IMAGES_PREF_KEY] === "on";
}

export async function readImagesEnabled() {
  return imagesEnabled(await readPreferences());
}
