# Deploy

The hosted web app is a static build. It needs no application server and holds no user documents or provider credentials. An optional fetch relay exists only for public sources that cannot be fetched directly by a browser.

The local package is distributed with browser artifacts generated before packing, so a package runner can start the MCP server immediately without building. The shared kernel and local host execute directly from the published source.

Release verification separates building from deployment. Continuous integration builds and verifies the exact static bytes that the deployment workflow later publishes. A deployment therefore cannot quietly rebuild different output.

Self-hosters can serve the static web output from any host that supports a fallback to the application entry page. The local MCP host and subscription bridge remain separate processes on the user's machine.

Generated command, environment, network-policy, and module maps carry the exact operational details; this guide records the deployment model that should remain true as those details evolve.
