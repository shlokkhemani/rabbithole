import { encodePathPreservingSlash, trimBaseUrl } from "./path.js";

/**
 * @param {{ baseUrl: string, namespace: string, repo: string, sha: string, relativePath: string, startLine: number, endLine: number }} input
 */
export function gitlabPermalink(input) {
  return `${trimBaseUrl(input.baseUrl)}/${encodePathPreservingSlash(input.namespace)}/${encodeURIComponent(input.repo)}/-/blob/${input.sha}/${encodePathPreservingSlash(input.relativePath)}#L${input.startLine}-${input.endLine}`;
}
