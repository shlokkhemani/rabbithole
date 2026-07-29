import { encodePathPreservingSlash, trimBaseUrl } from "./path.js";

/**
 * @param {{ baseUrl: string, project: string, repo: string, sha: string, relativePath: string, startLine?: number, endLine?: number }} input
 */
export function bitbucketDataCenterPermalink(input) {
  const anchor = Number.isSafeInteger(input.startLine)
    ? `#${input.startLine}${Number.isSafeInteger(input.endLine) && input.endLine !== input.startLine ? `-${input.endLine}` : ""}`
    : "";
  return `${trimBaseUrl(input.baseUrl)}/projects/${encodeURIComponent(input.project)}/repos/${encodeURIComponent(input.repo)}/browse/${encodePathPreservingSlash(input.relativePath)}?at=${encodeURIComponent(input.sha)}${anchor}`;
}
