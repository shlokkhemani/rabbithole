# Rabbithole Fetch Proxy

Stateless GET-only proxy for the static web app's URL-open flow.

Deploy with Wrangler:

```bash
cd workers/fetch-proxy && wrangler deploy
```

From the repo root, the original one-liner also works:

```bash
wrangler deploy workers/fetch-proxy/index.js --name rabbithole-fetch-proxy
```

The deployed Worker at `https://rabbithole-fetch-proxy.khemanishlok.workers.dev` is baked
into every build as the default link relay (`PUBLIC_FETCH_PROXY_URL` in `build.mjs`).
Set `RABBITHOLE_PROXY_URL` at build time to override it, or set it to an empty string to
ship a build with no default relay. The app sends requests as:

```text
https://your-worker.example/?url=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762
```

Users can still edit the link relay under Settings → Advanced; clearing the field disables
relayed fetches for that browser.

## Allowlist Rationale

The proxy exists only for academic-reading sources that often block browser CORS:

- `arxiv.org`, `www.arxiv.org`: canonical arXiv pages and PDFs.
- `ar5iv.labs.arxiv.org`, `ar5iv.org`: HTML renderings of arXiv papers, preferred over PDFs when available.
- `openreview.net`: paper pages commonly used for ML research. Note: OpenReview currently
  fronts requests with a browser-verification challenge, so relayed fetches usually fail
  with an interstitial or 403 — allowlisted in case that changes, but not advertised in
  the app's copy.

It is deliberately not a general web proxy. The handler accepts only GET, strips cookies/auth headers in both directions, caps responses at 25 MB while streaming, passes through only `content-type`, and never logs request or response bodies.
