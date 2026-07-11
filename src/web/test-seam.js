/*
 * Rule 10 test contract: this is the sole shipped test seam. Every entry below
 * exists only for state or artifact inspection that cannot be observed through
 * the product UI; product actions themselves must be driven through real UI.
 */
export function installTestSeam({ store, currentHoleId, createDocument, exportSnapshot, exportPortable }) {
  window.__rabbitholeTest = Object.freeze({
    // Routing/reload tests need the raw persistence identity, which the product UI does not expose.
    currentHoleId,
    // Persistence-migration tests need raw persistence records before product loading normalizes them.
    readStoredHole: async (id = currentHoleId()) => id ? readRawRecord(store, id) : null,
    // Asset-ingest tests need binary asset names and byte sizes, which rendered product content cannot reveal.
    inspectAssets: async (id = currentHoleId()) => {
      const names = id ? await store.listAssets(id) : [];
      const sizes = {};
      for (const name of names) sizes[name] = (await store.getAsset(id, name))?.size || 0;
      return { names, sizes };
    },
    // Asset-MIME migration tests need binary asset Blob types, which live rendering hides.
    inspectAssetType: async (name, id = currentHoleId()) => (await store.getAsset(id, name))?.type || "",
    // Empty-store persistence tests need raw persistence record counts, which empty product chrome cannot distinguish.
    listStoredHoles: () => store.listHoles(),
    // Structured-authoring tests need author-model rewrite fixtures, for which the product has no equivalent UI action.
    createDocument,
    // Snapshot byte/content tests need pre-download artifact strings, which the download UI cannot return.
    exportSnapshot,
    // Portable-projection tests need pre-download artifact strings to compare with the snapshot HTML carrier.
    exportPortable,
  });
}

async function readRawRecord(store, id) {
  const db = await store.open();
  const tx = db.transaction("holes", "readonly");
  const request = tx.objectStore("holes").get(id);
  const value = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
  return value == null ? null : structuredClone(value);
}
