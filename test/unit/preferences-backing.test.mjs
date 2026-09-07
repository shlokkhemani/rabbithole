/** @protects durable reader preference backing capability contracts. */
import assert from "node:assert/strict";
import { createHostPreferenceBacking } from "../../src/ui/preference-host-backing.js";

const local = new Map([
  ["rh-reading-scale", "0.9"],
  ["unrelated", "leave-me-here"],
]);
let localReads = 0;
globalThis.localStorage = {
  get length() {
    return local.size;
  },
  clear: () => local.clear(),
  getItem: (key) => {
    localReads += 1;
    return local.get(key) ?? null;
  },
  key: (index) => Array.from(local.keys())[index] ?? null,
  removeItem: (key) => {
    local.delete(key);
  },
  setItem: (key, value) => {
    local.set(key, String(value));
  },
};

const root = {
  attributes: new Map(),
  classList: { add() {}, remove() {} },
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  },
  setAttribute(name, value) {
    this.attributes.set(name, value);
  },
};
const documentTarget = new EventTarget();
documentTarget.hidden = false;
documentTarget.documentElement = root;
(/** @type {any} */ (globalThis)).document = documentTarget;
const windowTarget = new EventTarget();
windowTarget.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(/** @type {any} */ (globalThis)).window = windowTarget;
globalThis.matchMedia = windowTarget.matchMedia;

const {
  aiImagesEnabled,
  applyPreferencePatch,
  AI_IMAGES_PREF_KEY,
  autoTidyEnabled,
  configurePreferenceBacking,
  onPreferenceChange,
  readingScale,
  resetPreferenceBacking,
  setAutoTidyEnabled,
  setAiImagesEnabled,
  setReadingScale,
} = await import("../../src/ui/preferences.js");

assert.equal(readingScale(), 0.9, "without a backing preferences keep using localStorage");

const forwarded = [];
configurePreferenceBacking({
  seed: { "rh-reading-scale": "1.2", "rh-auto-tidy": "on" },
  write: (key, value) => forwarded.push([key, value]),
});
const readsBeforeBackedAccess = localReads;
assert.equal(readingScale(), 1.2, "the host seed wins before the first preference read");
assert.equal(autoTidyEnabled(), true);
assert.equal(localReads, readsBeforeBackedAccess, "a non-empty host seed never consults the random origin");
assert.equal(aiImagesEnabled(), false, "AI images default off in an empty host seed");
assert.equal(setReadingScale(1.3), 1.3, "host-backed writes update the synchronous cache");
assert.equal(readingScale(), 1.3);
assert.equal(setAutoTidyEnabled(false), false);
assert.equal(setAiImagesEnabled(true), true);
assert.equal(aiImagesEnabled(), true);
assert.equal(setAiImagesEnabled(false), false);
assert.deepEqual(forwarded, [
  ["rh-reading-scale", "1.3"],
  ["rh-auto-tidy", null],
  [AI_IMAGES_PREF_KEY, "on"],
  [AI_IMAGES_PREF_KEY, null],
]);

const kinds = [];
const stop = onPreferenceChange((kind) => kinds.push(kind));
assert.equal(applyPreferencePatch({ "rh-reading-scale": "1.4", "rh-auto-tidy": "on" }), true);
assert.equal(readingScale(), 1.4, "an SSE patch updates the same cache without reposting");
assert.equal(autoTidyEnabled(), true);
assert.deepEqual(forwarded.length, 4, "a remote patch never loops back through the writer");
assert.equal(applyPreferencePatch({ [AI_IMAGES_PREF_KEY]: "on" }), true);
assert.equal(aiImagesEnabled(), true);
assert.deepEqual(kinds, ["reading-scale", "auto-tidy", "ai-images"]);
stop();

resetPreferenceBacking();
assert.equal(readingScale(), 0.9, "reset restores the default localStorage backing");

const emptySeedPosts = [];
const emptySeedWriter = createHostPreferenceBacking({
  seed: {},
  post: (payload) => emptySeedPosts.push(payload),
  debounceMs: 10,
  documentTarget,
  windowTarget,
});
const readsBeforeEmptySeed = localReads;
configurePreferenceBacking(emptySeedWriter);
assert.equal(readingScale(), 1, "an empty machine seed starts from defaults");
assert.equal(localReads, readsBeforeEmptySeed, "host-backed preferences never consult the random origin");
await emptySeedWriter.flush();
assert.deepEqual(emptySeedPosts, [], "an empty seed does not create a preference patch");
resetPreferenceBacking();
emptySeedWriter.dispose();

const posts = [];
const writer = createHostPreferenceBacking({
  seed: {},
  post: (payload) => {
    posts.push(payload);
    return Promise.resolve({ ok: true });
  },
  debounceMs: 10,
  documentTarget,
  windowTarget,
});
writer.write("rh-theme", "dark");
writer.write("rh-theme", "light");
writer.write("rh-reading-scale", "1.1");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(posts, [{
  type: "preferences_patch",
  values: { "rh-theme": "light", "rh-reading-scale": "1.1" },
}], "rapid writes coalesce per key into one trailing patch");

writer.write("rh-auto-tidy", "on");
documentTarget.hidden = true;
documentTarget.dispatchEvent(new Event("visibilitychange"));
await writer.flush();
assert.deepEqual(posts.at(-1), { type: "preferences_patch", values: { "rh-auto-tidy": "on" } },
  "hiding the page flushes immediately");

writer.write("rh-auto-tidy", null);
windowTarget.dispatchEvent(new Event("pagehide"));
await writer.flush();
assert.deepEqual(posts.at(-1), { type: "preferences_patch", values: { "rh-auto-tidy": null } },
  "pagehide flushes deletions immediately");
writer.dispose();

console.log("durable reader preference backing ok");
