/** @typedef {import("../../../src/core/contracts/evidence.js").SourceRecord} SourceRecord */
/** @typedef {import("../../../src/core/contracts/evidence.js").EvidenceRecord} EvidenceRecord */

/** @type {SourceRecord} */
export const sourceRecordFixture = {
  id: "source-code-nora",
  type: "git-file",
  stableLocator: {
    repositoryId: "repo-main",
    path: "src/core/document-state.js",
    lines: { start: 1, end: 24 },
  },
  title: "document-state.js",
  revision: "main",
  commit: "0123456789abcdef0123456789abcdef01234567",
  capturedAt: "2026-07-28T10:00:00.000Z",
  extensions: { fixture: true },
};

/** @type {EvidenceRecord} */
export const evidenceRecordFixture = {
  id: "evidence-code-nora",
  sourceId: sourceRecordFixture.id,
  sourceType: sourceRecordFixture.type,
  stableLocator: sourceRecordFixture.stableLocator,
  title: sourceRecordFixture.title,
  excerpt: "export function createDocumentState(raw = {}) {",
  revision: sourceRecordFixture.revision,
  commit: sourceRecordFixture.commit,
  permalink: "https://github.com/r13v/Nora/blob/0123456789abcdef0123456789abcdef01234567/src/core/document-state.js#L1-L24",
  capturedAt: "2026-07-28T10:01:00.000Z",
  range: { path: "src/core/document-state.js", startLine: 1, endLine: 24 },
  extensions: { fixture: true },
};
