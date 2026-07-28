import { encodePathPreservingSlash, trimBaseUrl } from "./path.js";

/**
 * @param {{ baseUrl: string, owner: string, repo: string, sha: string, relativePath: string, startLine: number, endLine: number }} input
 */
export function githubPermalink(input) {
  return `${trimBaseUrl(input.baseUrl)}/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/blob/${input.sha}/${encodePathPreservingSlash(input.relativePath)}#L${input.startLine}-L${input.endLine}`;
}
