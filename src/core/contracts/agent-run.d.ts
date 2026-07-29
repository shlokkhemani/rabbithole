/**
 * Persisted Nora Agent Run summary.
 *
 * Full model-facing message history lives in runs/<run-id>.jsonl. This summary
 * is the document.json index that the canvas and run details use.
 */

import type { NoraNodeState } from "./document.js";

export interface AgentRunSummary {
  id: string;
  parentRunId: string | null;
  targetNodeId: string | null;
  status: NoraNodeState;
  prompt: string;
  profileId: string | null;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: unknown | null;
  transcriptPath: string | null;
  extensions: Record<string, unknown>;
}
