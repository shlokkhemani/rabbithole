# ADR 0003: Package `.nora` as a ZIP container

- Status: Accepted
- Date: 2026-07-28

## Context

A Nora research must be portable as one `.nora` file. It contains structured canvas state, source evidence, complete agent history, snapshots, original PDFs, and other acquired binary attachments. Credentials and derived Git clones remain outside the artifact.

Plain JSON or XML could embed binary data as base64, but that would increase artifact size and turn binary changes into large textual rewrites.

## Decision

`.nora` is a versioned ZIP container.

- `manifest.json` stores the format version, entry metadata, and checksums.
- `document.json` stores canvas state, settings, and provenance.
- `runs/<run-id>.jsonl` stores complete ordered Pi history.
- `assets/<sha256>` stores original attachments as content-addressed binary entries and deduplicates repeated content.
- The container has an explicit format version and must reject unsupported future versions without truncating data.
- Git clone caches and all credentials remain external.

## Consequences

- One portable artifact can preserve the complete research and its original attachments.
- Binary files avoid base64 size overhead.
- VS Code integration uses a binary `CustomEditorProvider` with extension-owned save, backup, undo, and hot-exit behavior.
- Normal text diff and merge tools cannot meaningfully review the outer `.nora` file.
- Container size limits and oversized-attachment behavior require a separate product decision.

## Rejected Alternatives

- Plain JSON was rejected because original binary sources would require base64 encoding.
- Plain XML was rejected for the same reason and adds escaping complexity without a required interoperability benefit.
