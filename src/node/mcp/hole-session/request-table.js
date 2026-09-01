import { shortId } from "../../shared/ids.js";

/**
 * The complete live coordination record for one agent request. Document state
 * stays in HoleEngine; this table owns only request-lifetime facts.
 */
function createRecord(requestId) {
  return {
    requestId,
    nodeId: null,
    generation: null,
    cancelledNonBlocking: null,
    completedNodeId: null,
    watchdog: null,
    inFlight: null,
    delegated: false,
    nonBlocking: false,
    conversion: null,
  };
}

export class RequestTable {
  constructor() {
    /** @type {Map<string, ReturnType<typeof createRecord>>} */
    this.recordsById = new Map();
  }

  ensure(requestId) {
    let record = this.recordsById.get(requestId);
    if (!record) {
      record = createRecord(requestId);
      this.recordsById.set(requestId, record);
    }
    return record;
  }

  get(requestId) {
    return this.recordsById.get(requestId) || null;
  }

  mintId(mint = shortId) {
    while (true) {
      const id = mint();
      if (!this.recordsById.has(id)) return id;
    }
  }

  records() {
    return this.recordsById.values();
  }

  pending(requestId, nodeId) {
    const record = this.ensure(requestId);
    record.nodeId = nodeId;
    record.cancelledNonBlocking = null;
    return record;
  }

  convert(requestId, conversion) {
    const record = this.ensure(requestId);
    record.nodeId = conversion.node_id;
    record.conversion = conversion;
    return record;
  }

  deliver(requestId, event) {
    const record = this.ensure(requestId);
    record.inFlight = event;
    return record;
  }

  delegate(requestId) {
    const record = this.ensure(requestId);
    record.delegated = true;
    record.nonBlocking = true;
    return record;
  }

  reclaim(requestId) {
    const record = this.ensure(requestId);
    record.delegated = false;
    record.nonBlocking = false;
    return record;
  }

  beginAnswer(requestId) {
    const record = this.ensure(requestId);
    record.delegated = false;
    record.inFlight = null;
    return record;
  }

  answer(requestId, nodeId) {
    const record = this.ensure(requestId);
    record.nodeId = null;
    record.generation = null;
    record.nonBlocking = false;
    record.conversion = null;
    record.completedNodeId = nodeId;
    return record;
  }

  cancelSubtree(doomedNodeIds) {
    const cancelled = [];
    for (const record of this.recordsById.values()) {
      if (!record.nodeId || !doomedNodeIds.has(record.nodeId) || record.completedNodeId) continue;
      record.cancelledNonBlocking = record.nonBlocking;
      record.nodeId = null;
      record.generation = null;
      record.inFlight = null;
      record.delegated = false;
      record.nonBlocking = false;
      cancelled.push(record);
    }
    return cancelled;
  }

  deleteConversionForNode(nodeId) {
    for (const record of this.recordsById.values()) {
      if (record.conversion?.node_id === nodeId) record.conversion = null;
    }
  }

  clearActive() {
    for (const record of this.recordsById.values()) {
      record.generation = null;
      record.inFlight = null;
      record.delegated = false;
      record.nonBlocking = false;
    }
  }

  clearWatchdogs(clear = clearTimeout) {
    for (const record of this.recordsById.values()) {
      if (record.watchdog) clear(record.watchdog);
      record.watchdog = null;
    }
  }
}
