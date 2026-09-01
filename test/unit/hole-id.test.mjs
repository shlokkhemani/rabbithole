/** @protects hole id capability contracts. */
import assert from "node:assert/strict";
import {
  createWhimsicalHoleId,
  holeIdFromPathname,
  isValidHoleId,
  pathnameForHole,
  SHORT_HOLE_ID_PATTERN,
  UUID_HOLE_ID_PATTERN,
  WHIMSICAL_HOLE_ID_PATTERN,
} from "../../src/web/hole-id.js";

const id = createWhimsicalHoleId({
  randomBytes: () => Uint8Array.from([8, 49, 10, 11, 12, 13, 14, 15]),
});
assert.equal(id, "curious-teacup-abcdef");
assert.match(id, WHIMSICAL_HOLE_ID_PATTERN);
assert.equal(pathnameForHole(id), "/curious-teacup-abcdef");
assert.equal(holeIdFromPathname(`/${id}`), id);
assert.equal(holeIdFromPathname(`/${id}/`), id);

const shortId = "a1b2c3d4";
const legacyUuid = "12345678-1234-1234-1234-123456789abc";
assert.match(shortId, SHORT_HOLE_ID_PATTERN);
assert.match(legacyUuid, UUID_HOLE_ID_PATTERN);
assert.equal(isValidHoleId(shortId), true);
assert.equal(isValidHoleId(legacyUuid), true);
assert.equal(pathnameForHole(shortId), `/${shortId}`);
assert.equal(pathnameForHole(legacyUuid), `/${legacyUuid}`);
assert.equal(holeIdFromPathname(`/${shortId}`), shortId);
assert.equal(holeIdFromPathname(`/${legacyUuid}`), legacyUuid);

for (const pathname of ["/", "/app.js", "/curious-teacup", `/${id}/nested`, "/Curious-teacup-abcdef", "/%E0%A4%A"]) {
  assert.equal(holeIdFromPathname(pathname), "", `reject ${pathname}`);
}
assert.throws(() => pathnameForHole("hole-123"), /Invalid browser Rabbithole id/);
assert.throws(
  () => createWhimsicalHoleId({ randomBytes: () => new Uint8Array(7) }),
  /at least 8 random bytes/,
);

console.log("ok browser Rabbithole id validation accepts short, UUID, and legacy whimsical paths");
