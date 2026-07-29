export class DocumentMutationQueue {
  constructor() {
    /** @type {Promise<void>} */
    this.tail = Promise.resolve();
    /** @type {Promise<void> | null} */
    this.followingTurnDelay = null;
  }

  /**
   * Serialize document mutations while still letting long work happen outside
   * the queue when callers capture an immutable snapshot first.
   * @template T
   * @param {() => T | Promise<T>} work
   * @returns {Promise<T>}
   */
  enqueue(work) {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => this.#consumeFollowingTurnDelay(),
      () => this.#consumeFollowingTurnDelay(),
    );
    return run;
  }

  releaseFollowingTurn() {
    this.followingTurnDelay = new Promise((resolve) => setImmediate(resolve));
  }

  /** @returns {Promise<void>} */
  drain() {
    return this.tail;
  }

  #consumeFollowingTurnDelay() {
    const delay = this.followingTurnDelay;
    this.followingTurnDelay = null;
    return delay ?? undefined;
  }
}
