const SECRET_QUERY_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization|auth|key)$/i;
const SCP_REMOTE_RE = /^(?:([^@\s/:]+)@)?([A-Za-z0-9.-]+):(?![/\\])(.+)$/;

/**
 * @typedef {"github" | "gitlab" | "bitbucket-cloud" | "bitbucket-data-center"} ForgeType
 * @typedef {{
 *   gitUrl: string,
 *   sanitizedUrl: string,
 *   transport: "http" | "ssh",
 *   host: string,
 *   path: string,
 *   forgeType: ForgeType | null,
 *   forgeBaseUrl: string,
 *   owner?: string,
 *   namespace?: string,
 *   workspace?: string,
 *   project?: string,
 *   repo: string
 * }} NormalizedRemote
 */

export class CredentialBearingUrlError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CredentialBearingUrlError";
  }
}

/**
 * Normalize a Git remote for storage/hash/permalink classification while
 * preserving a usable Git URL for acquisition.
 * @param {string} raw
 * @param {{ forgeType?: ForgeType | null, forgeBaseUrl?: string | null }} [options]
 * @returns {NormalizedRemote}
 */
export function normalizeRemoteUrl(raw, options = {}) {
  const value = requireRemoteString(raw);
  const parsed = parseRemote(value);
  const forgeBaseUrl = options.forgeBaseUrl
    ? normalizeForgeBaseUrl(options.forgeBaseUrl)
    : defaultForgeBaseUrl(parsed);
  const forgeType = classifyForge(parsed.host, options.forgeType ?? null);
  const parts = forgeType ? repositoryParts(parsed.path, forgeType) : repositoryParts(parsed.path, "github");
  return {
    gitUrl: value,
    sanitizedUrl: parsed.sanitizedUrl,
    transport: parsed.transport,
    host: parsed.host,
    path: parsed.path,
    forgeType,
    forgeBaseUrl,
    ...parts,
  };
}

/**
 * @param {string} host
 * @param {ForgeType | null} selected
 * @returns {ForgeType | null}
 */
export function classifyForge(host, selected = null) {
  const lower = host.toLowerCase();
  if (lower === "github.com") return "github";
  if (lower === "gitlab.com") return "gitlab";
  if (lower === "bitbucket.org") return "bitbucket-cloud";
  return selected;
}

/**
 * @param {string} raw
 * @returns {raw is ForgeType}
 */
export function isForgeType(raw) {
  return raw === "github" || raw === "gitlab" || raw === "bitbucket-cloud" || raw === "bitbucket-data-center";
}

/** @param {string} value */
function requireRemoteString(value) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("Git remote URL must be a non-empty string");
  return value.trim();
}

/** @param {string} value */
function parseRemote(value) {
  if (SCP_REMOTE_RE.test(value) && !looksLikeUrl(value)) {
    const match = value.match(SCP_REMOTE_RE);
    if (!match) throw new TypeError("Invalid SCP-style Git remote");
    const host = normalizeHost(match[2]);
    const remotePath = normalizeRemotePath(match[3]);
    return {
      transport: /** @type {"ssh"} */ ("ssh"),
      host,
      path: remotePath,
      forgeBaseUrl: `https://${host}`,
      sanitizedUrl: `ssh://${host}/${remotePath}`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Unsupported Git remote URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") {
    throw new TypeError(`Unsupported Git remote protocol: ${url.protocol}`);
  }
  rejectCredentials(url);
  const host = normalizeHost(url.hostname);
  const remotePath = normalizeRemotePath(url.pathname);
  const sanitized = new URL(`${url.protocol}//${host}/${remotePath}`);
  for (const [key, entryValue] of [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    sanitized.searchParams.append(key, entryValue);
  }
  return {
    transport: url.protocol === "ssh:" ? /** @type {"ssh"} */ ("ssh") : /** @type {"http"} */ ("http"),
    host,
    path: remotePath,
    forgeBaseUrl: url.protocol === "ssh:" ? `https://${host}` : `${url.protocol}//${host}`,
    sanitizedUrl: sanitized.toString().replace(/\/$/, ""),
  };
}

/** @param {URL} url */
function rejectCredentials(url) {
  if (url.protocol === "ssh:") {
    if (url.password) throw new CredentialBearingUrlError("SSH Git remote URL must not contain a password");
  } else if (url.username || url.password) {
    throw new CredentialBearingUrlError("Git remote URL must not contain URL userinfo");
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) {
      throw new CredentialBearingUrlError(`Git remote URL must not contain credential-bearing query parameter ${key}`);
    }
  }
}

/** @param {string} host */
function normalizeHost(host) {
  const value = host.toLowerCase();
  if (!value) throw new TypeError("Git remote host is required");
  return value;
}

/** @param {string} remotePath */
function normalizeRemotePath(remotePath) {
  let value = remotePath.replace(/^\/+/, "").replace(/\/+$/, "");
  try {
    value = decodeURI(value);
  } catch {}
  if (!value || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("Git remote path must name a repository");
  }
  return value;
}

/** @param {{ transport: "http" | "ssh", host: string, forgeBaseUrl: string }} parsed */
function defaultForgeBaseUrl(parsed) {
  return parsed.forgeBaseUrl;
}

/** @param {string} value */
function normalizeForgeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Forge base URL must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("Forge base URL must use http or https");
  rejectCredentials(url);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * @param {string} remotePath
 * @param {ForgeType} forgeType
 */
function repositoryParts(remotePath, forgeType) {
  const parts = remotePath.split("/").filter(Boolean);
  if (forgeType === "bitbucket-data-center") {
    const dataCenter = bitbucketDataCenterParts(parts);
    return {
      project: dataCenter.project,
      repo: stripGitSuffix(dataCenter.repo),
    };
  }
  if (parts.length < 2) throw new TypeError("Git remote path must include owner and repository");
  const repo = stripGitSuffix(parts.at(-1) ?? "");
  if (!repo) throw new TypeError("Git remote path must include a repository name");
  if (forgeType === "gitlab") {
    return {
      namespace: parts.slice(0, -1).join("/"),
      repo,
    };
  }
  if (forgeType === "bitbucket-cloud") {
    return {
      workspace: parts[0],
      repo,
    };
  }
  return {
    owner: parts[0],
    repo,
  };
}

/** @param {string[]} parts */
function bitbucketDataCenterParts(parts) {
  if (parts.length >= 4 && parts[0].toLowerCase() === "projects" && parts[2].toLowerCase() === "repos") {
    return { project: parts[1], repo: parts[3] };
  }
  if (parts.length >= 3 && parts[0].toLowerCase() === "scm") {
    return { project: parts[1], repo: parts[2] };
  }
  if (parts.length >= 2) return { project: parts[0], repo: parts[1] };
  throw new TypeError("Bitbucket Data Center remote path must include project and repository");
}

/** @param {string} value */
function stripGitSuffix(value) {
  return value.replace(/\.git$/i, "");
}

/** @param {string} value */
function looksLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
