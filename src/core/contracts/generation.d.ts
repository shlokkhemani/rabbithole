/**
 * Shared generation adapter vocabulary.
 *
 * Runtime authority for the browser provider surfaces and their current raw-text
 * streams: {@link ../../web/provider/openai-compatible.js}. Current consumers and
 * title extraction are {@link ../../web/transport/direct-host.js},
 * {@link ../../web/provider/title-sentinel.js}, and {@link ../../web/app.js}.
 * The MCP path is normalized by
 * {@link ../../node/mcp/hole-session/generation-ingress.js} before entering the same
 * `Run`; it has no browser-style `Provider` and receives partial/final
 * tool calls carrying `content`, `partial`, and `title` instead.
 *
 * Browser brains emit this vocabulary: branch adapters contain sentinel
 * parsing and authoring adapters emit text events only. The MCP host remains a
 * separate wire ingress with its own persistence policy.
 * Transport-level run tagging uses `ProgressRun` from {@link ./engine.js}; it
 * is intentionally not redeclared here.
 * `Run` runtime behavior is authoritative in
 * {@link ../hole/run.js}; `DocEvent` output shapes remain authoritative
 * in {@link ../hole/reduce.js} and are described by {@link ./engine.js}.
 */

import type { NodeAnsweredEvent, NodeProgressEvent } from "./engine.js";

export interface TextGenerationEvent {
  type: "text";
  delta: string;
}

export interface TitleGenerationEvent {
  type: "title";
  title: string;
}

export type GenerationEvent = TextGenerationEvent | TitleGenerationEvent;

/**
 * Browser generation surface shared by today's OpenAI-compatible and
 * Anthropic brains. Inputs remain opaque here because prompt builders own their
 * shapes; the stable adapter boundary is the three method names, abort signal,
 * and generated event stream.
 */
export interface Provider {
  answerBranch(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorExplainer(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorDocument(source: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
}

export interface RunOptions {
  id: string;
  initialMarkdown?: string;
  fallbackTitle?: string;
}

export interface RunSnapshot {
  id: string;
  seq: number;
  markdown: string;
  title: string;
}

export interface ProgressDocContext {
  nodeId?: string;
  progressFields?: Record<string, unknown>;
}

export interface AnsweredDocContext {
  nodeId: string;
  answeredFields?: Record<string, unknown>;
}

export declare class Run {
  constructor(options: RunOptions);
  accept(event: GenerationEvent, context?: ProgressDocContext): NodeProgressEvent | null;
  complete(context: AnsweredDocContext): NodeAnsweredEvent;
  snapshot(): RunSnapshot;
}
