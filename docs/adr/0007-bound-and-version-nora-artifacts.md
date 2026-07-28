# ADR 0007: Bound and version `.nora` artifacts

- Status: Accepted
- Date: 2026-07-28

## Context

Nora embeds original PDFs, other attachments, and complete agent history. Unbounded artifacts could make VS Code save, backup, recovery, and transfer behavior unreliable.

Although migration from Rabbithole is not required, users must not lose Nora research when the released format evolves.

## Decision

- Limit each embedded attachment to 100 MiB.
- Limit the complete `.nora` artifact to 1 GiB.
- Reject an oversized mutation before it can replace the last valid artifact.
- Include an explicit format version.
- Migrate released `.nora` versions forward beginning with the first public Nora format.
- Do not migrate `.rabbithole` data.
- Do not implement Nora-specific encryption.
- Do not collect telemetry or crash reports.

## Consequences

- Save and backup behavior has explicit operating bounds.
- Forward migrations become a compatibility requirement after the first release.
- Corporate data protection relies on filesystem, endpoint, repository, and organizational controls.
- Product behavior cannot be measured through built-in telemetry; diagnostics are user-initiated and local.

## Rejected Alternatives

- Unlimited artifact size was rejected because it makes editor reliability unpredictable.
- Application-level encryption was rejected because it would introduce key management without replacing corporate storage controls.
