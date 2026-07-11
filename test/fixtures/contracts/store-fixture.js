/** @typedef {import("../../../src/core/contracts/store.js").RabbitholeStore} RabbitholeStore */

/** @type {RabbitholeStore} */
export const storeFixture = {
  async listHoles() { return []; },
  async loadHole(_holeId) { return null; },
  async saveHole(_hole, _options) {},
  async deleteHole(_holeId) {},
  async listAssets(_holeId) { return []; },
  async getAsset(_holeId, _name) { return new Blob(); },
  async putAsset(_holeId, _name, _bytes) {},
  async deleteAsset(_holeId, _name) {},
  async createStaging() { return { ingest_id: "ingest-fixture" }; },
  async putStagedAsset(_ingestId, _name, _bytes) {},
  async adoptStagedAssets(_holeId, _ingestId) { return []; },
};

