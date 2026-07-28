import { uriToString } from "./nora-document.js";

export class DocumentRegistry {
  constructor() {
    /** @type {Map<string, import("./nora-document.js").NoraDocument>} */
    this.documents = new Map();
    /** @type {string | null} */
    this.activeKey = null;
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  add(document) {
    const key = uriToString(document.uri);
    this.documents.set(key, document);
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
    const key = uriToString(document.uri);
    this.documents.delete(key);
    if (this.activeKey === key) this.activeKey = null;
  }

  /** @param {import("./nora-document.js").NoraDocument} document */
  setActive(document) {
    const key = uriToString(document.uri);
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
}
