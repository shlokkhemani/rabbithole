import { encodePathPreservingSlash, trimBaseUrl } from "./path.js";

/**
 * @param {{ baseUrl: string, project: string, repo: string, sha: string, relativePath: string }} input
 */
export function bitbucketDataCenterPermalink(input) {
  return `${trimBaseUrl(input.baseUrl)}/projects/${encodeURIComponent(input.project)}/repos/${encodeURIComponent(input.repo)}/browse/${encodePathPreservingSlash(input.relativePath)}?at=${encodeURIComponent(input.sha)}`;
}
