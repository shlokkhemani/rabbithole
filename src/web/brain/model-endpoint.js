export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(String(value || "").trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchOpenAICompatibleModels(baseUrl, { apiKey = "", signal } = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  // A relative value would resolve against this origin and quietly probe the app itself.
  if (!isHttpUrl(base)) throw Object.assign(new Error("Enter a full URL, like https://api.example.com/v1."), { code: "invalid_url" });
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${base}/models`, { headers, signal, ...addressSpaceHint(base) });
  if (!response.ok) {
    throw Object.assign(new Error(`Model endpoint returned HTTP ${response.status}.`), { status: response.status });
  }
  const json = await response.json();
  const data = json?.data === null ? [] : json?.data;
  if (!Array.isArray(data)) throw new Error("Model endpoint returned an invalid model list.");
  return data.filter((model) => model?.id).map((model) => ({
    id: String(model.id),
    name: String(model.name || model.id),
  })).filter((model) => !/embed/i.test(`${model.id} ${model.name}`));
}

/*
 * Chrome puts a permission prompt in front of any request that leaves the public internet
 * for a machine on the user's own network, and it can only prompt when it knows the target
 * lives there. It infers that from an IP literal; anything else has to say so up front.
 * Claiming wrongly is worse than staying quiet — a request annotated for the local network
 * that resolves somewhere public is failed outright — so only literals and mDNS names,
 * which cannot resolve anywhere else, are claimed.
 */
export function addressSpaceHint(url) {
  const space = addressSpaceOf(url);
  return space ? { targetAddressSpace: space } : {};
}

export function addressSpaceOf(url) {
  let hostname;
  try { hostname = new URL(String(url || "")).hostname.toLowerCase(); } catch { return ""; }
  if (hostname === "localhost") return "loopback";
  if (hostname.startsWith("[")) return ipv6AddressSpace(hostname.slice(1, -1));
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
  if (octets) {
    if (octets.some((octet) => octet > 255)) return "";
    const [a, b] = octets;
    if (a === 127) return "loopback";
    // RFC 1918, plus the link-local range a machine picks when there is no DHCP.
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "local";
    return "";
  }
  return hostname.endsWith(".local") ? "local" : "";
}

function ipv6AddressSpace(address) {
  if (address === "::1") return "loopback";
  // Unique local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(address)) return "local";
  return /^fe[89ab]/.test(address) ? "local" : "";
}
