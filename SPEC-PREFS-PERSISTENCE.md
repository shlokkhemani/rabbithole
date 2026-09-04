# Spec: Durable reader preferences (follow-up to SPEC-AUTO-TIDY)

Status: ready for implementation. Sequencing: land **after** the Auto-tidy build
merges — this spec touches `src/ui/preferences.js` internals that Auto-tidy is
adding keys to, and it deliberately changes nothing about any key's meaning.

## 1. Problem

Every MCP-backed canvas is served by a per-session server bound to port 0
(`src/node/mcp/hole-session/session-base.js` — `server.listen(0, "127.0.0.1")`).
Each new rabbithole therefore opens on a fresh origin
(`http://127.0.0.1:<random>`), and reader preferences — theme, reading size,
Quick-questions presets, Auto-tidy — live in `localStorage`, which is
per-origin. The user configures their presets, opens the next rabbithole, and
everything is factory-reset. On rabbithole.ing the origin is stable, so the web
app does not have this bug; frozen snapshots already have their own
memory-fallback story.

This is not a storage bug, it is a **scoping** bug: preferences describe the
person at the machine, but they are being keyed by an ephemeral origin.

## 2. Structural principles (normative)

These are the load-bearing decisions. An implementation that violates one of
them is wrong even if it passes the tests.

1. **Preferences remain reader-state, never document state.** The charter at
   the top of `preferences.js` stands: preferences never enter the hole JSON,
   the `node_update` wire, exports, the portable format, or frozen snapshots.
   This spec relocates their durable home; it does not change their nature.
2. **The durable home of local reader-state is the machine, not a browser
   origin.** Locally that home already exists: the Rabbithole data dir
   (`process.env.RABBITHOLE_DIR || ~/.rabbithole`). Preferences persist there
   as `preferences.json`, beside the holes, honoring the same
   `RABBITHOLE_DIR` test-isolation seam.
3. **The engine stays document-pure.** `engine.hydration()` builds a projection
   of the document. Preferences must NOT pass through it. They are attached at
   the HTTP layer, only on the page-serve path (§5), so `/snapshot-hole`,
   `/export`, and every other projection is preference-free *by construction*,
   not by filtering.
4. **Backing is a composition-root concern.** The web app boots through the
   same `startRabbithole` live host as the MCP canvas
   (`src/web/canvas-runtime.js` re-exports `src/ui/entry.js`); only the
   transport adapter differs. So "host-backed vs storage-backed" cannot key
   off the host module — it is an explicit `options.preferences` handed to
   `startRabbithole`, exactly like `options.transport`. The MCP boot page
   passes it; web and frozen pass nothing and keep today's behavior
   byte-for-byte.
5. **One write grammar.** Browser→host preference writes ride the existing
   typed event bus (`POST /events`) as a new event type, named in the house
   patch grammar: `preferences_patch` (sibling of `node_extensions_patch`).
   No new endpoint, no second channel.
6. **Keys and encodings do not change.** The stored values are the exact
   string encodings `readStored`/`writeStored` use today (`"rh-theme"`,
   `"rh-reading-scale"`, `"rh-ask-presets-v1"`, `"rh-auto-tidy"`,
   `"rh-auto-tidy-grace"`, and any future `rh-*` key). The backing swaps the
   store underneath the encoding — it never reinterprets a value. Auto-tidy
   and every future preference ride this channel with zero per-feature work.

## 3. Data model

`<RABBITHOLE_DIR>/preferences.json`:

```json
{
  "version": 1,
  "values": {
    "rh-theme": "dark",
    "rh-reading-scale": "1.1",
    "rh-ask-presets-v1": "{…}"
  }
}
```

- `values` maps storage key → stored string. Deletion of a key means the
  preference returns to its default (mirrors `removeStored`).
- Unknown keys are **preserved on merge**, never dropped: an older host must
  not eat a newer client's preference.
- Missing or unparsable file ⇒ treat as empty `{version: 1, values: {}}`,
  log a warning, and let the next write recreate it. Corruption never blocks
  a page serve.

## 4. Client: the backing seam in `preferences.js`

Add a pluggable backing with localStorage as the default. No public preference
API (`themeSetting`, `readingScale`, `askPreset`, `autoTidyEnabled`, …)
changes signature or semantics.

```js
// backing = { seed: Record<string, string>, write(key, value /* string|null */): void }
export function configurePreferenceBacking(backing) { … }
export function resetPreferenceBacking() { … }
```

- **Default (no backing configured):** `readStored`/`writeStored`/`removeStored`
  behave exactly as today — localStorage with the in-memory fallback for
  unwritable stores. Web and frozen never call `configurePreferenceBacking`,
  so their behavior is provably unchanged (their code path is the same code).
- **Host-backed:** `readStored` resolves from an in-page cache initialized
  from `backing.seed` (memory-fallback semantics preserved: a value the
  backing refused still holds for the life of the page). `writeStored` updates
  the cache synchronously — every existing synchronous read stays correct —
  and forwards to `backing.write`. localStorage is not consulted at all in
  this mode: on a random origin it is dead weight, and consulting it would
  create a second source of truth.
- **Ordering guarantee:** the backing must be configured before the first
  preference read. The live composition already applies the theme during
  chrome init, so `startRabbithole` configures the backing (from
  `options.preferences`) before `createRabbitholeUi` runs anything that reads
  a preference. Guard this with a unit test, not a runtime assertion.
- **Lifecycle:** the runtime's dispose resets the backing
  (`resetPreferenceBacking`), same pattern as `resetSnapshotHooks`. An
  in-document hole switch keeps the page, the session, and therefore the
  backing.

### Write coalescing

Preset editing writes on every `input` event. Host-backed writes must coalesce:
a trailing debounce (400 ms, matching `SAVE_DEBOUNCE_MS`) with per-key
coalescing — the patch accumulates `{key: latestValue}` and flushes as one
`preferences_patch`. Flush immediately on `visibilitychange → hidden` and on
`pagehide` (the transport's `flushPendingSaves` seam is the model; use
`navigator.sendBeacon` fallback only if the existing transport already has
one — do not introduce a new mechanism for this). A failed post keeps the
cache value: the preference holds for the life of the page, identical to
today's unwritable-localStorage behavior.

## 5. Host: session layer

### Storage module

New `src/node/mcp/store/prefs-store.js`:

- `readPreferences(): Promise<Record<string,string>>` — returns the `values`
  map (empty on missing/corrupt).
- `mergePreferences(patch: Record<string, string|null>): Promise<void>` —
  read-modify-write of the whole file: apply the patch per key (`null`
  deletes), preserve unknown keys, then write atomically via
  temp-file + `fs.rename` with a `randomUUID` temp name — the exact pattern
  `fs-store.js` uses for `saveHole`. Concurrent sessions (even in different
  agent processes) then converge to per-key last-write-wins without ever
  clobbering each other's unrelated keys or torn-writing the file.

### Read path (page serve only)

In `src/node/mcp/http/routes.js`, the `GET /` handler attaches the seed
around the document hydration, not inside it:

```js
const page = await session.renderPage({ ...session.buildHydration(), preferences: await readPreferences() });
```

`buildHydration()` itself is untouched (principle 3): any other consumer of
the hydration projection stays preference-free automatically. The boot script
in `src/node/mcp/http/page.js` passes the seed through as
`options.preferences` to `startRabbithole`; the hydration object handed to
`createRabbitholeUi` must have the `preferences` field stripped so it cannot
leak toward snapshot or export code paths in the page.

### Write path

The `/events` dispatch table in `src/node/mcp/hole-session/session.js` gains:

```js
preferences_patch: (event) => { …validate…; return mergePreferences(event.values).then(() => ({ ok: true })); },
```

Validation (reject with the existing 400 grammar):
- `values` is a plain object; every key matches `/^rh-[a-z0-9-]+$/`; every
  value is a string or `null`.
- Per-value cap 64 KB, whole-patch cap 256 KB — presets are the largest
  legitimate payload (8 presets × 4000-char instructions ≈ 32 KB with JSON
  overhead); the caps protect the file from a runaway client without ever
  touching a legitimate write.

### Same-session sync (in scope, small)

After a successful merge, `broadcast({ type: "preferences", values })` over
SSE. The client applies received values through the same cache-update path as
a local write (without re-posting) and fires the existing
`notify(kind)` so live surfaces re-render — two tabs of the same canvas stay
in agreement, and a theme change follows you across them.

**Out of scope, explicitly:** cross-session push (two different holes open in
two different agent processes). They share the file, so each new page load —
and each session's own writes — converge; live file-watching between
processes is complexity this feature does not need. Note this in the code
where broadcast happens, so nobody "fixes" it casually.

## 6. What does not change

- **Web (rabbithole.ing):** no backing configured; localStorage on a stable
  origin, as today. Local and web preferences do not sync — different
  machines' reader-state, acceptable and intended.
- **MCP empty seed:** starts from defaults and never consults the page origin's
  localStorage.
- **Frozen snapshots:** no backing; memory-fallback for unwritable stores, as
  today. The snapshot HTML must contain no preference values — enforced by
  construction (§5) and by test.
- **`preferences.js` public API, every `rh-*` key, every encoding, the
  settings sheet, Auto-tidy:** untouched. Auto-tidy's keys persist across
  canvases the moment this lands, with no change to its spec or code.

## 7. Edge cases

- **Storage dir unwritable / disk full:** `mergePreferences` failure is logged
  and returns `{ok: true}` to the client anyway? No — return the normal error;
  the client's debounced writer swallows post failures and keeps the cache
  value (page-lifetime persistence, same as today's degraded mode). Never
  surface a toast for a preference write.
- **Two canvases racing on one key:** per-key last-write-wins at the file;
  each page keeps its own cache until its next load. Acceptable; documented.
- **Old client (pre-feature dist) against new host:** sends no
  `preferences_patch`; nothing breaks. New client against old host: `POST
  /events` rejects the unknown type with 400; the debounced writer swallows
  it; behavior degrades exactly to today's. No version negotiation needed.
- **`RABBITHOLE_DIR` in tests:** every integration/e2e test gets a throwaway
  dir (the `check:install-live` seam), so tests never touch the developer's
  real preferences.

## 8. Tests

Unit (`test/unit/preferences-backing.test.mjs`):
- Backing-off behavior is byte-identical to today (readStored/writeStored
  against localStorage + memory fallback).
- Host-backed: seed resolves reads; writes update cache synchronously and
  forward; `null` forwards deletion; reset restores default backing.
- An empty host seed uses defaults without reading localStorage.
- Coalescing: N rapid writes to one key ⇒ one patch with the last value;
  writes to distinct keys merge into one patch; hidden/pagehide flushes.

Unit (`test/unit/prefs-store.test.mjs`):
- Merge semantics: per-key apply, `null` deletes, unknown keys preserved,
  corrupt file ⇒ empty + recreated on next write, atomic temp+rename (no
  partial file observable mid-write).

Contracts:
- `preferences_patch` validation: key shape, value types, size caps, 400
  grammar on violation.
- Snapshot/export projections contain no `preferences` field and no `rh-*`
  values regardless of file contents.

Integration:
- Serve page → post a theme patch → start a **new session on a new port**
  (same `RABBITHOLE_DIR`) → served page's seed carries the theme. This is the
  test that encodes the bug this spec kills.
- SSE broadcast reaches a second connected client of the same session.

E2E:
- An empty machine seed ignores stale `rh-*` values on the random page origin.
- Change a Quick-questions preset in canvas A; open canvas B (new session,
  same throwaway `RABBITHOLE_DIR`); the preset is there.
- Frozen snapshot of a hole whose owner has customized everything: sheet
  shows defaults-per-frozen-rules, page source contains no preference values.
- Web app harness: settings behave exactly as before (no backing path).

## 9. Acceptance checklist

- [ ] Theme, reading size, Quick-questions presets, and Auto-tidy settings
      survive across newly created rabbitholes on one machine.
- [ ] `preferences.json` lives in `RABBITHOLE_DIR`, written atomically,
      per-key merged, unknown keys preserved.
- [ ] Engine hydration, snapshot, export, and portable projections are
      preference-free by construction.
- [ ] Web and frozen code paths are unchanged (no backing configured).
- [ ] `preferences_patch` is the only write channel; validated; size-capped.
- [ ] Same-session SSE sync works; cross-session push explicitly absent and
      commented.
- [ ] All tests in §8 green; existing suites untouched and green.
