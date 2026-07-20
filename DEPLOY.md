# Deploy Rabbithole

These steps prepare the Cloudflare Pages app at the root of
`rabbithole.ing`. `npm run build:publish` publishes the static web app from
`web/dist` and copies deployment assets from `website/public`. `_redirects`
keeps browser document paths refreshable through the single-page app.

## First Pages Deploy

```bash
npm run build:publish
npx wrangler pages deploy publish --project-name rabbithole
```

## Fetch Proxy Worker

```bash
cd workers/fetch-proxy
npx wrangler deploy
cd ../..
```

Copy the Worker URL from Wrangler output. It should look like:

```text
https://rabbithole-fetch-proxy.<account>.workers.dev
```

## Domain Attachment

1. In Cloudflare, add the `rabbithole.ing` zone on the Free plan.
2. In Namecheap, change the domain nameservers to the two Cloudflare
   nameservers shown for that zone.
3. In the Cloudflare Pages project named `rabbithole`, add these custom
   domains:
   - `rabbithole.ing`
   - `www.rabbithole.ing`
4. Rebuild and redeploy Pages with the deployed Worker URL baked into the app:

```bash
RABBITHOLE_PROXY_URL=https://rabbithole-fetch-proxy.<account>.workers.dev npm run build:publish
npx wrangler pages deploy publish --project-name rabbithole
```

The `RABBITHOLE_PROXY_URL` build variable adds the Worker origin to the app CSP
and makes that URL the default fetch proxy setting. Users can still edit the
setting in the browser.
