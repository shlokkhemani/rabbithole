# Releasing Rabbithole

`package.json` is the single source of truth for the version. The CLI, the MCP
handshake, and the browser bundles all read it — the CLI and MCP server at
runtime, the bundles through constants `build.mjs` injects at build time.

The scheme is `0.MINOR.PATCH`. Tags are `vX.Y.Z`. Public copy names the minor
only ("Rabbithole v0.4"). A feature release bumps the minor; a fix-only release
bumps the patch.

## Cut a release

1. Edit `CHANGELOG.md`: rename the `## vX.Y.Z (unreleased)` heading to
   `## vX.Y.Z — YYYY-MM-DD`, trim the draft bullets to what a reader cares
   about, and commit on `main`.
2. Bump and tag:

   ```bash
   npm version minor   # or: npm version patch
   ```

   The `version` lifecycle script rebuilds `dist/` and `docs/` with the new
   version baked in and stages them, so the bump commit carries them.
3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

The `v*` tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml),
which verifies the tag matches `package.json`, runs the package gate, publishes
to npm with provenance, and creates the GitHub release from the matching
`CHANGELOG.md` section. Pushing the commit to `main` separately triggers CI and
the deploy of [rabbithole.ing](https://rabbithole.ing).

## One-time npm setup

Publishing uses npm trusted publishing (OIDC), so there is no `NPM_TOKEN`
secret. Configure it once on npmjs.com for `@shlokkhemani/rabbithole`:

**Settings → Publishing access → GitHub Actions**, repository
`shlokkhemani/rabbithole`, workflow `release.yml`.

Until that is configured, the publish step fails with an authentication error.
