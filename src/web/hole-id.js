const ADJECTIVES = Object.freeze([
  "amber", "brave", "bright", "calm", "clever", "cloudy", "cosmic", "cozy",
  "curious", "dapper", "dreamy", "dusky", "electric", "emerald", "fable", "feisty",
  "gentle", "glimmering", "golden", "hidden", "honey", "indigo", "jolly", "kindred",
  "lilac", "lively", "lucky", "lunar", "merry", "mossy", "nimble", "opal",
  "peachy", "playful", "plucky", "quiet", "radiant", "roaming", "rosy", "secret",
  "silver", "sleepy", "solar", "sparkly", "spry", "starry", "sunny", "swift",
  "teal", "tender", "tiny", "tranquil", "velvet", "violet", "wandering", "warm",
  "whimsy", "wild", "willow", "wise", "witty", "wondering", "woodland", "zesty",
]);

const NOUNS = Object.freeze([
  "acorn", "badger", "biscuit", "breeze", "brook", "burrow", "button", "candle",
  "carrot", "comet", "cricket", "dandelion", "daydream", "dewdrop", "feather", "fern",
  "firefly", "fox", "galaxy", "garden", "hare", "hazelnut", "hedgehog", "horizon",
  "jellybean", "kettle", "lantern", "lark", "meadow", "meteor", "moonbeam", "mushroom",
  "nest", "noodle", "otter", "pebble", "picnic", "pocket", "puddle", "quill",
  "rabbit", "rainbow", "ripple", "rocket", "scone", "shadow", "sparrow", "sprout",
  "starlight", "teacup", "thimble", "thunder", "toast", "truffle", "tulip", "tunnel",
  "waffle", "walnut", "whisker", "willow", "wonder", "wren", "yarrow", "zeppelin",
]);

const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const WHIMSICAL_HOLE_ID_PATTERN = /^[a-z]+-[a-z]+-[a-z0-9]{6}$/;

export function createWhimsicalHoleId({ randomBytes = secureRandomBytes } = {}) {
  const bytes = randomBytes(8);
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) {
    throw new Error("Whimsical hole IDs need at least 8 random bytes.");
  }
  const adjective = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  let suffix = "";
  for (let index = 2; index < 8; index += 1) {
    suffix += SUFFIX_ALPHABET[bytes[index] % SUFFIX_ALPHABET.length];
  }
  return `${adjective}-${noun}-${suffix}`;
}

export function holeIdFromPathname(pathname) {
  const match = /^\/([^/]+)\/?$/.exec(String(pathname || ""));
  if (!match) return "";
  let candidate;
  try { candidate = decodeURIComponent(match[1]); } catch { return ""; }
  return WHIMSICAL_HOLE_ID_PATTERN.test(candidate) ? candidate : "";
}

export function pathnameForHole(holeId) {
  if (!WHIMSICAL_HOLE_ID_PATTERN.test(String(holeId || ""))) {
    throw new Error(`Invalid browser Rabbithole id: ${JSON.stringify(holeId)}`);
  }
  return `/${holeId}`;
}

function secureRandomBytes(length) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(bytes);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}
