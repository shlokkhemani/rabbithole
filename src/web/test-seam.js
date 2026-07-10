export function installTestSeam({ store, currentHoleId, createDocument, exportSnapshot }) {
  window.__rabbitholeTest = Object.freeze({
    version: 1,
    store,
    currentHoleId,
    createDocument,
    exportSnapshot,
  });
}
