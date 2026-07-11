/**
 * Content and learning-primitive vocabulary for Phases 6–8.
 *
 * Runtime authority today is split. {@link ../markdown-renderer.js}
 * (`createMarkdownRenderer`) owns closed-fence dispatch: renderers are stored
 * by lowercased language and registered as `registerFenceRenderer(language,
 * render)`. `show` is the only built-in registration; unknown fences fall
 * through to highlighted/plain code. Its separate, hardcoded `show` tokenizer
 * emits the pending placeholder for an unclosed fence. {@link ../markdown.js}
 * exposes the same two-argument registration for the shared Node renderer.
 * Consequently `MarkdownExtension` describes that language/render pair; it is
 * not a claim that an object-shaped plugin registry exists at runtime.
 *
 * Client upgrade authority is {@link ../../ui/visuals.js}. Both
 * {@link ../../ui/entry.js} and {@link ../../ui/frozen-entry.js} call
 * `mountVisuals`, which finds `.viz[data-viz][data-src]`, skips pending
 * placeholders, base64-decodes the source, dispatches through the separate
 * `registerVisualHandler(type, build)` registry, and replaces the placeholder
 * with cached DOM. There is no `HydratableBlock` registry or lifecycle contract
 * today.
 *
 * IMPORTANT — PROVISIONAL AND REVISABLE: Phase 8's content spike owns the final
 * hydratable-block, primitive, lifecycle, identity, state, and security formats.
 * Phase 8 may revise these declarations without migration obligations. These
 * names exist only so Phase 6/7 code can share vocabulary; they do not freeze a
 * serialized format or promise compatibility for authored or learner state.
 */

export interface MarkdownRenderContext {
  /** Normalized first info-string word, preserving its source casing today. */
  language: string;
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
