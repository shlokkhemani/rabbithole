import assert from "node:assert/strict";
import {
  createWhimsicalHoleId,
  holeIdFromPathname,
  pathnameForHole,
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

for (const pathname of ["/", "/app.js", "/curious-teacup", `/${id}/nested`, "/Curious-teacup-abcdef", "/%E0%A4%A"]) {
  assert.equal(holeIdFromPathname(pathname), "", `reject ${pathname}`);
}
assert.throws(() => pathnameForHole("hole-123"), /Invalid browser Rabbithole id/);
assert.throws(
  () => createWhimsicalHoleId({ randomBytes: () => new Uint8Array(7) }),
  /at least 8 random bytes/,
);

console.log("ok whimsical browser Rabbithole ids and path routing");
