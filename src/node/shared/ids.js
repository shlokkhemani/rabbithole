import { randomBytes } from "node:crypto";
import { shortId as coreShortId } from "../../core/utils.js";

/** Node host adapter for the isomorphic short-id generator. */
export function shortId() {
  return coreShortId((length) => randomBytes(length));
}
