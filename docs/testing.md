# Testing Rabbithole

Rabbithole has no unit tests: behavior is proven through the running product, and end-to-end tests are the default home for new coverage. The remaining tiers group tests by the kind of promise they protect: cross-module contracts, host integration, browser journeys, performance budgets, and installed-package behavior.

The executable test runner discovers every test in the selected directory. A new test needs no hand-maintained command list. `npm test` runs the static checks (`npm run check:static`) and the five deterministic tiers below; installed-agent acceptance checks live separately in `test/isolation-live/` and run only through `npm run check:isolation-live`. The runner reports every failure and ends with passed, failed, and skipped totals.

Every test begins with an `@protects` declaration beside the code. The [generated test map](generated/test-map.md) is the authoritative, current inventory of files and capabilities. The [generated command map](generated/commands.md) is the authoritative command reference.

Use the narrowest tier that can observe a behavior:

1. End-to-end tests protect browser journeys, input ownership, accessibility, and cross-host movement.
2. Contract tests protect persisted formats, protocols, trust boundaries, bundle graphs, and storage behavior.
3. Integration tests protect a capability spanning the shared kernel and a host.
4. Performance tests protect reviewed size and timing ceilings.
5. Packaging tests protect clean installation and startup behavior.
6. Isolation-live tests protect Claude and Codex capability isolation against locally installed agent binaries. They are opt-in acceptance checks, never part of `npm test`.

Browser tests should prefer accessible roles, focus, keyboard operation, persisted outcomes, network scope, and exported artifacts over private DOM structure. Format tests should prove both acceptance of supported data and clear refusal of unsupported data.

Performance ceilings are reviewed product decisions. Recalibration merges new measurements into their existing rationale instead of replacing that context.

Live-provider evaluations are opt-in quality probes, not deterministic gates. Credentials and private documents never belong in fixtures, logs, snapshots, or committed output.
