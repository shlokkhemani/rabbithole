/**
 * Shared generation adapter vocabulary.
 *
 * Runtime authority for the browser brain surfaces and their current raw-text
 * streams: {@link ../../web/brain/openai-compatible.js} and
 * {@link ../../web/brain/index.js}. Current consumers and title extraction are
 * {@link ../../web/transport/direct-host.js},
 * {@link ../../web/brain/title-sentinel.js}, and {@link ../../web/app.js}.
 * The MCP path is normalized by
 * {@link ../../node/transport/generation-ingress.js} before entering the same
 * `GenerationRun`; it has no browser-style `Brain` and receives partial/final
 * tool calls carrying `content`, `partial`, and `title` instead.
 *
 * Browser brains emit this vocabulary: branch adapters contain sentinel
 * parsing and authoring adapters emit text events only. The MCP host remains a
 * separate wire ingress with its own persistence policy.
 * Transport-level run tagging uses `ProgressRun` from {@link ./engine.js}; it
 * is intentionally not redeclared here.
 * `GenerationRun` runtime behavior is authoritative in
 * {@link ../generation-run.js}; `DocEvent` output shapes remain authoritative
 * in {@link ../reducer.js} and are described by {@link ./engine.js}.
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
export interface Brain {
  answerBranch(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorExplainer(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorDocument(source: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
}

export interface GenerationRunOptions {
  id: string;
  initialMarkdown?: string;
  fallbackTitle?: string;
}

export interface GenerationRunSnapshot {
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

export declare class GenerationRun {
  constructor(options: GenerationRunOptions);
  accept(event: GenerationEvent, context?: ProgressDocContext): NodeProgressEvent | null;
  complete(context: AnsweredDocContext): NodeAnsweredEvent;
  snapshot(): GenerationRunSnapshot;
}
