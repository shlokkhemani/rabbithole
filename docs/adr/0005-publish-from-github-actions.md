# ADR 0005: Publish both registries from GitHub Actions

- Status: Accepted
- Date: 2026-07-28

## Context

Nora is distributed through Visual Studio Marketplace and Open VSX. Global Azure DevOps PATs retire on December 1, 2026, so the release pipeline must not depend on one.

Current public workflows demonstrate successful Marketplace publication directly from GitHub Actions through GitHub OIDC, Microsoft Entra, `azure/login`, and `vsce --azure-credential`. A separate Azure Pipeline is not required.

## Decision

GitHub Actions owns both CI and release automation.

For a version tag, the release workflow:

1. runs Linux-only tests and deterministic build checks on Node.js 24;
2. packages one VSIX;
3. attaches that VSIX and its checksum to the GitHub Release;
4. publishes the same VSIX to Visual Studio Marketplace using GitHub OIDC and an Entra federated application;
5. publishes the same VSIX to Open VSX using an Open VSX access token.

Nora does not add Azure Pipelines or a Marketplace PAT.
Nora ships one universal VSIX without native runtime dependencies. Generated extension and webview bundles are release artifacts rather than committed source.

## Consequences

- Both registries and GitHub Releases receive the identical package.
- Release automation remains in the repository's existing CI system.
- Linux is the only CI operating system; Windows and macOS receive no dedicated automated signal.
- Marketplace setup still requires an Entra application, federated GitHub credential, Marketplace publisher membership, and GitHub Actions variables or secrets.
- Open VSX setup requires an Eclipse publisher agreement, namespace, and access token.

## Rejected Alternatives

- Open VSX-only distribution was rejected because Marketplace publishing from GitHub Actions is demonstrably possible.
- Azure Pipelines was rejected because it adds a second CI system without being required.
- Marketplace PAT authentication was rejected because the required global PATs retire in 2026.
