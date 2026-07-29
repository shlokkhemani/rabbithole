import { uriToString } from "./nora-document.js";

export class DocumentRegistry {
  constructor() {
    /** @type {Map<string, import("./nora-document.js").NoraDocument>} */
    this.documents = new Map();
    /** @type {WeakMap<import("./nora-document.js").NoraDocument, string>} */
    this.documentKeys = new WeakMap();
    /** @type {string | null} */
    this.activeKey = null;
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  add(document) {
    const key = uriToString(document.uri);
    this.documents.set(key, document);
    this.documentKeys.set(document, key);
    const dispose = document.onDidDispose(() => this.delete(document));
    return {
      dispose: () => {
        dispose.dispose();
        this.delete(document);
      },
    };
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  delete(document) {
    const key = this.documentKeys.get(document) ?? uriToString(document.uri);
    if (this.documents.get(key) === document) this.documents.delete(key);
    this.documentKeys.delete(document);
    if (this.activeKey === key) this.activeKey = null;
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  setActive(document) {
    const key = this.#syncDocumentKey(document);
    if (this.documents.has(key)) this.activeKey = key;
  }

  clearActive() {
    this.activeKey = null;
  }

  get activeDocument() {
    return this.activeKey ? this.documents.get(this.activeKey) ?? null : null;
  }

  /** @param {unknown} uri */
  get(uri) {
    return this.documents.get(uriToString(uri)) ?? null;
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  #syncDocumentKey(document) {
    const previous = this.documentKeys.get(document);
    const next = uriToString(document.uri);
    if (!previous || previous === next) return next;
    if (this.documents.get(previous) === document) {
      this.documents.delete(previous);
      this.documents.set(next, document);
      this.documentKeys.set(document, next);
      if (this.activeKey === previous) this.activeKey = next;
    }
    return next;
  }
}
