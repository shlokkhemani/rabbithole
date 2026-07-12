# Compatibility

Rabbithole treats saved documents, portable files, snapshots, browser-local
settings, and the MCP wire as public interfaces. A release must either preserve
the behavior described here or make an explicit compatibility decision before
changing it.

Runtime validators are the authority for untrusted data. Type declarations
describe the accepted shapes, but do not replace validation at file, storage,
browser, or MCP boundaries.

## Compatibility at a glance

| Surface | Current form | Supported older input | Unsupported future input |
|---|---|---|---|
| Persisted hole | `schema_version: 2` | Missing, `null`, and version 1 schemas | Refused before mutation |
| Portable file | `format: "rabbithole"`, `format_version: 1` | Version 1 containing any supported hole schema | Refused as an unsupported file format |
| Snapshot HTML | Self-contained HTML with one inert portable payload | Older snapshots remain viewable as HTML | Payloads with unsupported format or hole versions are refused on import |
| Browser settings | Canonical `rh-web-settings` object and provider-key map | Legacy provider IDs and the single-key credential slot | Unknown or malformed settings fall back to safe defaults |
| MCP | Four named tools over the SDK's stdio protocol | Existing tool inputs, result statuses, and reattachment behavior | Breaking wire changes require a deliberate versioning decision |

## Persisted holes

`src/core/schema.js` owns the persisted document schema. New writes use schema
version 2. Both the filesystem store and IndexedDB store run the same migration
and validation path.

The following inputs are readable:

- Schema version 2 records.
- Records with `schema_version` omitted or set to `null`. These are interpreted
  as version 0.
- Schema version 1 records.

Migration to version 2 fills absent document and node defaults, adds an empty
`extensions` object where needed, and restores `base_url` metadata. A URL in a
node's frontmatter becomes a `frontmatter` base URL; descendants without their
own URL inherit it. Existing JSON-valued extension data is preserved
structurally.

A schema number greater than the current version is rejected with an
update-to-open message. Other unknown schema numbers are rejected as
unsupported. Rabbithole does not attempt a best-effort reconstruction of future
data because opening and resaving it could discard fields the current release
does not understand.

### Read and write behavior

Loading a supported old record is a write-through migration: the filesystem and
IndexedDB stores validate the migrated document, persist the canonical version,
and return it. Repeating the load is idempotent. Normal saves also project data
through the canonical version-2 writer.

Schema migration does not authorize unrelated content rewrites. For example,
opening and viewing saved Markdown does not mint block IDs or rewrite that
Markdown merely because the renderer can recognize an older fence form. Content
normalization occurs at an explicit authoring or import boundary.

The representative old records are
`test/fixtures/corpus/10-schema-null-legacy.rabbithole` and
`test/fixtures/corpus/11-v02-legacy.rabbithole`. The shared store contract in
`test/support/store-contract.mjs`, instantiated by
`test/contracts/filesystem-store.test.mjs` and
`test/contracts/indexeddb-store.test.mjs`, proves write-through migration,
idempotence, and future-version refusal. `test/contracts/data-boundaries.test.mjs`
proves null-schema and version-1 normalization, while
`test/e2e/cross-host-journey.test.mjs` carries the oldest supported fixture
through both hosts and both export forms.

## Portable `.rabbithole` files

A portable file is JSON with this envelope:

```json
{
  "format": "rabbithole",
  "format_version": 1,
  "hole": { "schema_version": 2 },
  "assets": {}
}
```

`hole` contains the canonical persisted document. `assets` maps validated asset
filenames to base64 data. Portable files are backups and device-transfer
artifacts, so they retain document extension state, including learner progress,
and include all assets stored for the hole. Preferences and credentials are not
part of the format.

Import validates the envelope before migrating its hole. Unknown format names or
format versions are refused; a supported envelope does not make an unsupported
hole schema acceptable. Malformed JSON, malformed base64, unsafe names, invalid
field types, and data over the import limits are rejected. If persistence fails
after a new hole has been created, the partial hole and its assets are removed.
An imported ID that already exists receives a fresh ID without changing its
content or assets.

`test/contracts/data-boundaries.test.mjs` proves validation, refusal, limits,
cleanup, and legacy migration. `test/contracts/artifact-roundtrip.test.mjs` runs
the curated corpus through import, storage, export, and re-import and requires a
canonical fixed point. `test/integration/artifact-portability.test.mjs` and
`test/e2e/cross-host-journey.test.mjs` prove the browser and MCP transfer paths.

## Snapshot HTML

A current snapshot is a self-contained, read-only HTML document. It embeds
exactly one version-1 portable projection in an inert
`application/vnd.rabbithole+json` script element. Opening the HTML renders the
snapshot without a server or network access; importing it extracts the payload
as text and never executes the surrounding document.

Snapshot projection is intentionally not identical to backup projection:

- It includes only assets referenced by the exported Markdown.
- It samples the view state at export time.
- It omits node `extensions`, because learner state is personal. Import restores
  the required empty extension objects.
- It never contains settings or credentials.

Snapshots made before the inert portable payload was introduced remain
self-contained view artifacts: users can open and read them as HTML. They cannot
be imported into the current library because there is no trusted interchange
payload to extract. This distinction is deliberate; Rabbithole refuses import
with a message explaining that the older file is still viewable.

`test/contracts/artifact-roundtrip.test.mjs` proves the portable/snapshot
projection differences and import fixed point. `test/contracts/data-boundaries.test.mjs`
proves inert extraction, missing or duplicate payload refusal, limits, and
cleanup. `test/contracts/compatibility-security.test.mjs` proves offline viewing,
secret exclusion, and hostile-content handling on live and frozen paths.
`test/contracts/mcp-markdown-wire.test.mjs` proves that MCP-produced snapshots use
the same canonical payload and can be imported by the web host.

## Browser preferences and credentials

Browser preferences and credentials are device-local state, separate from the
document store:

- `rh-web-settings` holds provider, endpoint, model, fetch-proxy, setup-readiness,
  and key-retention preferences.
- `rh-web-api-keys` maps canonical provider IDs to remembered keys.
- `rh-web-api-key` is the supported legacy single-key slot.
- `rh-theme` and `rh-last-hole` retain the selected theme and most recently used
  hole.

On startup, settings are canonicalized before use. Historical `anthropic` and
`openai` provider IDs resolve to `openrouter`, with canonical endpoint and model
settings. A complete older provider setup gains a versioned setup-readiness
fingerprint. Malformed settings use defaults instead of preventing startup.

The credential migration adopts a legacy `rh-web-api-key` as the OpenRouter key
only when that provider has no mapped key. It verifies that the canonical map was
written successfully before removing the legacy slot. The migration is
idempotent. Keys marked session-only remain in memory and are not converted into
remembered credentials.

Neither preferences nor credentials may enter persisted holes, portable files,
or snapshots. Import also removes keys shaped like the two credential storage
names from nested document data as defense in depth.

`test/contracts/compatibility-security.test.mjs` contains fixtures for the
current key map, the single-key form, older local settings, retired provider IDs,
malformed settings, and malformed credential maps. It proves canonical state,
idempotent reload, preservation of theme and last-hole preferences, continued key
usability, and secret exclusion from every artifact projection.

## MCP tools and session wire

The public MCP tool names are `open_rabbithole`, `answer_branch`, and
`list_rabbitholes`. `ingest_pdf` was retired in favor of passing a PDF directly
to `open_rabbithole { file_path }`. Their declared input schemas, validation limits, and
result status meanings are compatibility surfaces. So are the long-poll loop and
its durable session behavior:

- `branch_request` hands one saved ask to the agent. On a native-PDF parent it
  may carry `region { page, image_path }`, a local path to a transient JPEG crop
  of the selected region. Region files are not durable hole assets: each is
  removed once its request is answered and the rest at session close; a resumed
  saved ask re-crops its region under a fresh request ID.
- `answer_branch` accepts verbatim partial chunks and a final chunk.
- `keep_listening` directs the client to call `open_rabbithole` again with the
  returned hole ID without resending content.
- `session_closed` terminates the loop.
- Resuming a hole can attach rehydration context and saved asks to the first
  request.

The MCP contract evolves additively. New tools, optional input fields, and new
optional result metadata may be added. Existing tools, accepted inputs, status
names, field meanings, streaming concatenation, wait/rearm behavior, and
disconnect persistence are not removed or repurposed in place. Any unavoidable
breaking change needs a separately versioned protocol or tool surface and an
overlap period with the existing one.

## Native PDF nodes

Schema-v2 extension bags may contain `extensions.pdf` version 1. The namespace
stores 2x white-background JPEG page assets, page dimensions, and ordered
markdown-offset line geometry. Consumers strictly validate the version,
cardinality, asset names, finite geometry, and offsets; invalid or future PDF
extensions fall back to the deterministic markdown body. Frozen snapshots also
use that markdown fallback because frozen projection intentionally omits
extensions.

Line extraction clusters text items by baseline and then splits each cluster at
large horizontal gaps, so multi-column layouts yield one line record per column
segment; reading order (and therefore the markdown body and provenance offsets)
runs down each column, not across the gutter. Line records from older ingests
that predate the split remain valid — geometry validation does not care how
wide a line is.

`node_extensions_patch { node_id, namespace, value }` replaces one extension
namespace and is carried by both the local browser adapter and node-host event
stream. Native page assets participate in the same deletion, survivor, and undo
reference accounting as markdown `asset:` references. PDF files opened by web
upload or MCP `file_path` use the same normalized builder and persist the same
body/provenance shape; page JPEG encoder bytes may differ by host.

Page assets are budgeted at ingest (20 MB aggregate, with per-page scale
reduction) and conversion figures at 2 MB, on both hosts. Those numbers are
sized so a maxed-out hole still round-trips through the portable format: base64
inflates assets 4/3 against the 32 MB import payload cap, and
`test/integration/pdf-portability-caps.test.mjs` fails any budget change that
breaks that arithmetic.

Conversion adds browser events `convert_pdf { node_id }` and `convert_cancel`,
plus the emitted-only `pdf_convert_progress { node_id, markdown, page_done,
page_total }`. During a run `extensions.pdf.converting` is true and
`original_markdown` is retained for abort/reload recovery; successful completion
sets `converted` while preserving the page/provenance stash. Mid-run persistence
may capture the streamed body — hydration and resume restore the stashed
original on both hosts, and a conversion whose agent was never listening (or
died mid-run) resurfaces as `status=convert_request` with `saved=true`. The
node-host agent loop returns `status=convert_request` with local page image
paths and inline transcription rules; an unanswered `convert_request` is
redelivered across wait/rearm cycles like any in-flight request. Asks targeting
a converting node are refused host-side. The web preferences key
`transcribe_model` is independent of author/answer model setup readiness.

Selection branches on native PDF nodes retain the ordinary markdown
`offset_start`/`offset_end` pair and may additionally carry
`anchor.pdf { page, rect: { x, y, w, h } }`. Page numbers are positive integers
and normalized rectangle values are bounded to the page. Older consumers may
ignore this additive field; live PDF renderers use it for rectangle marks and
must never pass its markdown offsets into rendered-DOM range machinery.

Persisted schema safety applies equally to MCP resume: a newer saved schema is
refused before a session opens. Host-specific durable-ask semantics are also
preserved. Browser-authored pending nodes may retain partial Markdown; the MCP
host persists a pending ask with empty Markdown so a resumed agent answers it
fresh.

`test/contracts/mcp-markdown-wire.test.mjs` pins tool result shapes, streaming,
Markdown hydration, rehydration boundaries, canonical export/import, non-mutating
legacy viewing, and future-schema refusal. `test/integration/mcp-rearm.test.mjs`
proves keep-listening, reattachment, waiter cleanup, and exactly-once requeue.
`test/packaging/install-smoke.test.mjs` verifies a clean installed package can
complete the MCP initialize handshake.

## Changing or retiring compatibility

Compatibility code is not temporary merely because its inputs are old. It may be
removed only through a deliberate support decision that includes all of the
following:

1. Identify the exact persisted shape, file version, snapshot generation, browser
   key, or MCP behavior being retired.
2. Establish that supported users can migrate without clearing data or losing
   content, assets, learner state, or credentials.
3. Provide a clear refusal or upgrade path for artifacts that will no longer
   open; never silently reinterpret them.
4. Update this contract and user-facing release notes in the same change.
5. Keep the historical fixture until the last release that performs the migration
   is outside the supported upgrade path. Replace acceptance coverage with refusal
   coverage when that distinction remains relevant.

New persisted or portable versions require migration fixtures for every supported
predecessor and explicit future-version refusal tests. Additive fields should use
an extension-preserving boundary or be refused by older builds; they must never be
silently erased by an open-modify-save cycle.
