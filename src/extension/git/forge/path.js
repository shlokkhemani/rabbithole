/** @param {string} value */
export function encodePathPreservingSlash(value) {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** @param {string} value */
export function trimBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
