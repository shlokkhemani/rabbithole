/** @typedef {import("../../../src/core/contracts/content.js").MarkdownExtension} MarkdownExtension */
/** @typedef {import("../../../src/core/contracts/content.js").HydratableBlock<{ label: string }>} HydratableBlock */
/** @typedef {import("../../../src/core/contracts/content.js").Primitive<{ label: string }>} Primitive */

/** @type {MarkdownExtension} */
export const markdownExtensionFixture = {
  language: "show",
  render(source, context) {
    return `<div data-viz="${context.language}">${source}</div>`;
  },
};

/** @type {HydratableBlock} */
export const hydratableBlockFixture = {
  type: "check",
  version: 1,
  parse(source) { return { label: source }; },
  renderStatic(model) { return `<div>${model.label}</div>`; },
  hydrate(container, model) {
    const element = document.createElement("div");
    element.textContent = model.label;
    container.appendChild(element);
    return {
      element,
      update(props) { if (props.label !== undefined) element.textContent = props.label; },
      destroy() { element.remove(); },
    };
  },
};

/** @type {Primitive} */
export const primitiveFixture = {
  mount(container, props) {
    const element = document.createElement("button");
    element.textContent = props.label;
    container.appendChild(element);
    return {
      element,
      update(next) { if (next.label !== undefined) element.textContent = next.label; },
      destroy() { element.remove(); },
    };
  },
};
