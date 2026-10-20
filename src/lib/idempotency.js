/**
 * In-memory idempotency store with TTL.
 *
 * Webhook senders retry on timeouts, so the same event can arrive several
 * times. The first request claims the key; later requests either get the
 * stored result (completed) or a 409 (still in flight).
 *
 * For more than one gateway replica, swap this for a shared store (Redis
 * `SET key value NX PX ttl`) behind the same interface.
 * @module idempotency
 */

/**
 * @typedef {{state:'in_flight'} | {state:'completed', result:object} } Entry
 */

export class IdempotencyStore {
  /** @param {{ttlMs:number, now?: () => number, maxEntries?: number}} opts */
  constructor({ ttlMs, now = Date.now, maxEntries = 50000 }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxEntries = maxEntries;
    /** @type {Map<string, Entry & {expiresAt:number}>} */
    this.map = new Map();
  }

  #prune() {
    const t = this.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= t) this.map.delete(k);
    }
    // Map preserves insertion order, so the oldest keys go first.
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  /**
   * Try to claim a key.
   * @param {string} key
   * @returns {{claimed:true} | {claimed:false, entry:Entry}}
   */
  claim(key) {
    this.#prune();
    const existing = this.map.get(key);
    if (existing) return { claimed: false, entry: existing };
    this.map.set(key, { state: 'in_flight', expiresAt: this.now() + this.ttlMs });
    return { claimed: true };
  }

  /** @param {string} key @param {object} result */
  complete(key, result) {
    this.map.set(key, { state: 'completed', result, expiresAt: this.now() + this.ttlMs });
  }

  /** Forget a key so the sender may retry (used when we reject the request). */
  release(key) {
    this.map.delete(key);
  }

  size() {
    this.#prune();
    return this.map.size;
  }
}
