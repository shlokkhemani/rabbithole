/**
 * Content and learning-primitive vocabulary for Phases 6–8.
 *
 * Runtime block authority is {@link ../blocks.js}. Its descriptor registry
 * drives closed-fence placeholders and pending-fence recognition in
 * {@link ../markdown-renderer.js}; unknown fences remain highlighted/plain
 * code. `show` and `check` are the built-in descriptors.
 *
 * Client mounts are bound to those same descriptors in
 * {@link ../../ui/visuals.js}. Both
 * {@link ../../ui/entry.js} and {@link ../../ui/frozen-entry.js} call
 * `mountVisuals`, which finds `.viz[data-viz][data-src]`, skips pending
 * placeholders, base64-decodes the source, dispatches through the separate
 * `registerBlockMount(type, mountSpec)`, and replace placeholders with cached
 * DOM. Sanitized descriptors can only supply HTML strings; the framework owns
 * sanitization and insertion before optional wiring.
 *
 * IMPORTANT — PROVISIONAL AND REVISABLE: Phase 8's content spike owns the final
 * hydratable-block, primitive, lifecycle, identity, state, and security formats.
 * A future content-model revision may change these declarations without
 * migration obligations. These names let current code share vocabulary; they
 * do not freeze a serialized format or promise compatibility for authored or
 * learner state.
 */

export interface MarkdownRenderContext {
  /** Normalized first info-string word, preserving its source casing today. */
  language: string;
}

export interface BlockTypeDescriptor<Model = unknown> {
  type: string;
  version: number;
  parse(source: string): Model;
  toPlainText(model: Model): string;
  security: "sanitize-html" | "inert";
}

export interface BlockMountSpec<Model = unknown> {
  renderHtml?(model: Model): string;
  wire?(rootElement: HTMLElement, model: Model, context: BlockMountContext): void;
}

/** PROVISIONAL plain-text Check v1 model; authored field text is not Markdown. */
export interface CheckModel {
  question: string;
  options: string[];
  answer: number;
  explanation?: string;
}

export interface BlockMountContext {
  node_id: string;
  block_id: string;
  state: Record<string, unknown>;
  recordBlockState(state: Record<string, unknown>): Promise<unknown>;
}

/** Vocabulary projection of today's two-argument fence registration. */
export interface MarkdownExtension {
  /** Fence language; runtime registration normalizes this key to lowercase. */
  language: string;
  /** Static, synchronous HTML renderer for the closed fence source. */
  render(source: string, context: MarkdownRenderContext): string;
}

export interface HydratableBlock<Model = unknown> {
  type: string;
  /** Declaration version only; no persisted encoding is specified here. */
  version: number;
  parse(source: string): Model;
  /** Produces the inert/static representation used before or without upgrade. */
  renderStatic(model: Model): string;
  /** Upgrades an existing container and returns its provisional lifecycle. */
  hydrate(container: HTMLElement, model: Model): Handle<Model>;
}

/** PROVISIONAL Phase 8 primitive-kit vocabulary. */
export interface Primitive<Props> {
  mount(container: HTMLElement, props: Props): Handle<Props>;
}

/** PROVISIONAL lifecycle shared by hydratable blocks and primitives. */
export interface Handle<Props = unknown> {
  element: HTMLElement;
  update(props: Partial<Props>): void;
  destroy(): void;
}
