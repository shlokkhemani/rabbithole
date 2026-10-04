/*
 * Rule 10 test contract: this is the sole shipped test seam. Every entry below
 * exists only for state or artifact inspection that cannot be observed through
 * the product UI; product actions themselves must be driven through real UI.
 */
export function installTestSeam({
  store,
  currentHoleId,
  createDocument,
  waitForCanvasViewSettled,
  selectionAnchorClipBounds,
  exportSnapshot,
  exportPortable,
  autoTidyClock,
}) {
  const seam = {
    // Routing/reload tests need the raw persistence identity, which the product UI does not expose.
    currentHoleId,
    // Persistence tests need raw records before the store's read boundary clones them.
    readStoredHole: async (id = currentHoleId()) => id ? readRawRecord(store, id) : null,
    // Asset-ingest tests need binary asset names and byte sizes, which rendered product content cannot reveal.
    inspectAssets: async (id = currentHoleId()) => {
      const assets = !id
        ? []
        : typeof store.getAssets === "function"
          ? await store.getAssets(id)
          : await Promise.all((await store.listAssets(id)).map(async (name) => ({ name, blob: await store.getAsset(id, name) })));
      const names = [];
      const sizes = {};
      for (const { name, blob } of assets) {
        names.push(name);
        sizes[name] = blob?.size || 0;
      }
      return { names, sizes };
    },
    // Asset tests need binary Blob types, which live rendering hides.
    inspectAssetType: async (name, id = currentHoleId()) => (await store.getAsset(id, name))?.type || "",
    // Empty-store persistence tests need raw persistence record counts, which empty product chrome cannot distinguish.
    listStoredHoles: () => store.listHoles(),
    // Structured-authoring tests need model rewrite fixtures, for which the product has no equivalent UI action.
    createDocument,
    // Camera glides run in a JavaScript rAF loop, outside the Web Animations API.
    // Selection tests need its real completion promise before emulating a user gesture.
    waitForCanvasViewSettled,
    // Keep synthetic selection visibility on the product's exact visual-viewport/overflow geometry.
    selectionAnchorClipBounds,
    // Snapshot byte/content tests need pre-download artifact strings, which the download UI cannot return.
    exportSnapshot,
    // Portable-projection tests need pre-download artifact strings to compare with the snapshot HTML carrier.
    exportPortable,
  };
  if (typeof autoTidyClock?.advance === "function") {
    // Time is environmental state: tests still drive every product action through the real UI.
    seam.advanceAutoTidyClock = (ms) => autoTidyClock.advance(ms);
  }
  window.__rabbitholeTest = Object.freeze(seam);
}

async function readRawRecord(store, id) {
  const db = await store.open();
  const tx = db.transaction(["holes", "meta"], "readonly");
  const read = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
  const value = await read(tx.objectStore("holes").get(id));
  // A view saved after the hole's last full write is kept beside it.
  const view = await read(tx.objectStore("meta").get(`view:${id}`));
  if (value && view) value.view_state = view.view_state;
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
  // IndexedDB already returns a structured clone owned by this request.
  return value;
}
