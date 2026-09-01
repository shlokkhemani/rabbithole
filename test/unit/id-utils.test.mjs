/** @protects short id and copied-id normalization capability contracts. */
import assert from "node:assert/strict";
import { normalizeId, shortId } from "../../src/core/utils.js";

const sample = shortId(() => Uint8Array.from([0, 15, 16, 255]));
assert.equal(sample, "000f10ff");
assert.match(sample, /^[a-f0-9]{8}$/);

let counter = 0;
const ids = new Set();
for (let index = 0; index < 10_000; index += 1) {
  const value = counter++;
  ids.add(shortId(() => Uint8Array.from([
    value >>> 24,
    value >>> 16,
    value >>> 8,
    value,
  ])));
}
assert.equal(ids.size, 10_000);

assert.equal(normalizeId("  a1b2c3d4  "), "a1b2c3d4");
assert.equal(normalizeId('"a1b2c3d4"'), "a1b2c3d4");
assert.equal(normalizeId("' a1 b2 c3 d4 '"), "a1b2c3d4");
assert.equal(normalizeId("`a1b2\tc3d4`"), "a1b2c3d4");
assert.equal(normalizeId(null), "");

console.log("ok ids: secure 8-hex generation, 10k deterministic uniqueness, and copied-id normalization");
