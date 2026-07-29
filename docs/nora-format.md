# Nora Archive Format

`.nora` files are versioned ZIP archives. The archive is the portable state for
one research document: canvas state, evidence, attachment metadata, run
summaries, complete model-facing transcripts, and byte-exact attachments.

Nora v1 does not import earlier product formats and does not attempt partial
reconstruction of future `.nora` versions.

## Container Layout

```text
manifest.json
document.json
runs/<run-id>.jsonl
assets/<lowercase-sha256>
```

Only these paths are valid. Paths must be relative, NFC-normalized ZIP file
paths with `/` separators. Directory entries, absolute paths, Windows drive
paths, traversal segments, unsupported locations, duplicate names, and
case-colliding names are rejected.

## Manifest

`manifest.json` is the archive root of trust after ZIP structural validation.
It is canonical UTF-8 JSON with one trailing LF:

```json
{
  "format": "nora",
  "formatVersion": 1,
  "documentId": "document-id",
  "createdAt": "2026-07-29T00:00:00.000Z",
  "updatedAt": "2026-07-29T00:00:00.000Z",
  "entries": [
    {
      "path": "document.json",
      "mediaType": "application/json",
      "bytes": 1234,
      "sha256": "lowercase-hex-sha256"
    }
  ]
}
```

`entries` includes every archive entry except `manifest.json`, is sorted by
path, and must include `document.json`. Each declared entry must exist exactly
once in the ZIP, and every non-manifest ZIP entry must be declared.

Nora accepts only `formatVersion: 1`. A newer format version fails clearly and
non-lossily.

## Structured Encoding

`document.json`, `manifest.json`, and every transcript JSONL record use
canonical Nora JSON:

- UTF-8.
- LF line endings.
- One trailing LF for structured JSON files.
- Object keys sorted lexicographically.
- Undefined fields omitted.
- Arrays kept in semantic order.

`runs/<run-id>.jsonl` contains one canonical JSON object per LF-terminated line.
Empty run files are valid. Non-object lines, malformed JSON, missing trailing LF,
and non-canonical records are rejected.

## Document Contract

`document.json` is a `NoraDocument` with `schemaVersion: 1`. Runtime validation
is implemented in `src/core/document-schema.js`; the exported TypeScript shape is
in `src/core/contracts/document.d.ts`.

The document includes:

- Stable document ID, root node ID, title, creation/update timestamps, selected
  LLM profile ID, view state, and selection metadata.
- Nodes with Markdown, base URL metadata, origin metadata, geometry, collapsed
  state, read state, source/evidence/attachment references, run ID, and extension
  data.
- Edges between nodes.
- Source records and evidence records.
- Attachment metadata pointing to `assets/<sha256>`.
- Agent Run summaries pointing to `runs/<run-id>.jsonl`.
- Check records.
- Extension bags validated as JSON-compatible data.

Node and run statuses are:

- `pending`
- `running`
- `complete`
- `cancelled`
- `failed`
- `interrupted`

Persisted `running` runs are terminalized as failed/interrupted when reopened,
because the in-process Pi session cannot survive process shutdown.

Unknown future document schema versions are rejected with a clear error instead
of being truncated or downgraded.

## Source and Evidence Records

`SourceRecord` and `EvidenceRecord` are defined in
`src/core/contracts/evidence.d.ts`.

Evidence records include:

- Source type.
- Stable locator.
- Title.
- Excerpt.
- Revision or commit when present.
- Immutable permalink when present.
- Capture time.
- Optional range metadata.

Code evidence stores immutable commit data and never stores local worktree paths
as portable source locations.

## Attachments

Attachments are stored as raw bytes under `assets/<sha256>`. The asset path must
match the SHA-256 digest of the raw bytes. Attachment metadata in `document.json`
stores ID, hash, media type, title, original filename when available, byte count,
source ID, evidence IDs, creation time, and extension data.

Limits:

- One asset may be at most `100 * 1024 * 1024` raw bytes.
- `document.json` may be at most `16 * 1024 * 1024` bytes.
- One `runs/<run-id>.jsonl` transcript may be at most `64 * 1024 * 1024` bytes.
- Total uncompressed archive entry bytes may be at most `1024 * 1024 * 1024`.
- The final ZIP file may be at most `1024 * 1024 * 1024` bytes.

Nora preflights mutations that would exceed these limits. Rejected mutations do
not increment the in-memory revision and do not damage the last valid saved
document.

## Agent Run Transcripts

`document.json` stores compact Agent Run summaries. Full model-facing history is
stored in `runs/<run-id>.jsonl`.

Transcript records are append ordered and include replayable user, assistant,
tool-call, and tool-result records plus non-replayable assistant checkpoints and
terminal run records. The transcript stores the bounded values actually shown to
Pi, including MCP results after Nora's output bounds are applied. It excludes
transport retry chatter, reconnect diagnostics, raw stack traces, and internal
adapter logs.

During a run, Nora appends one complete LF-terminated record before publishing
the matching document revision and byte cutoff. Bytes beyond the published
cutoff are never exposed to readers, saves, backups, exports, or replay.

A save captures `document.json` and all per-run byte cutoffs as one immutable
snapshot. If the document advances while the ZIP stream is being written, the
normal save rejects with a retryable conflict and VS Code remains dirty.

## Deterministic Writes

Nora writes ZIP entries in sorted path order. JSON and JSONL are deflated at
level 9. Assets are stored without recompression so unchanged bytes remain
byte-exact. ZIP entry timestamps are fixed to `1980-01-01T00:00:00Z` and file
mode `0o100600`.

`updatedAt` changes only when the logical document revision changes. Repeated
saves of the same revision produce deterministic bytes.

## Safe Failure Behavior

Nora refuses archives with unsupported paths, encryption, CRC mismatch,
undeclared or missing entries, malformed JSON/JSONL, invalid document schema,
future format/schema versions, hash mismatch, asset-name mismatch, size
violations, duplicate entries, or case-colliding entries.

Normal saves write to a sibling temporary file, fsync it, replace the target
atomically where the platform permits, then fsync the parent directory on local
filesystems. The Windows replacement fallback preserves a backup until the new
file is in place. A failed save leaves the previous target and in-memory
revision intact.
