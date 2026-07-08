export class ProviderError extends Error {
  constructor(message, { status = null, code = null, retryable = true } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code || (status ? String(status) : null);
    this.retryable = retryable;
  }
}

export function normalizeProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err?.name === "AbortError") {
    return new ProviderError("The provider request was aborted.", { code: "abort", retryable: true });
  }
  return new ProviderError(err?.message || "The provider request failed.", { code: "network", retryable: true });
}
