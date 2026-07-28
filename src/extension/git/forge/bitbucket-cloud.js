import { encodePathPreservingSlash, trimBaseUrl } from "./path.js";

/**
 * @param {{ baseUrl: string, workspace: string, repo: string, sha: string, relativePath: string, startLine: number }} input
 */
export function bitbucketCloudPermalink(input) {
  const fileName = input.relativePath.split("/").at(-1) ?? input.relativePath;
  return `${trimBaseUrl(input.baseUrl)}/${encodeURIComponent(input.workspace)}/${encodeURIComponent(input.repo)}/src/${input.sha}/${encodePathPreservingSlash(input.relativePath)}#${encodeURIComponent(fileName)}-${input.startLine}`;
}
