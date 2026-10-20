/**
 * Three-state circuit breaker (closed -> open -> half_open -> closed).
 *
 * When ServiceNow is down, retrying every webhook would pile up slow requests
 * and hammer the instance as it recovers. After `failureThreshold`
 * consecutive failures the breaker opens and calls fail fast (and go to the
 * DLQ). After `resetTimeoutMs` one trial call is let through.
 * @module circuitBreaker
 */

export class CircuitOpenError extends Error {
  constructor(retryInMs) {
    super(`circuit open; next trial in ${retryInMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryInMs = retryInMs;
  }
}

export class CircuitBreaker {
  /**
   * @param {{failureThreshold:number, resetTimeoutMs:number, now?: () => number,
   *   isFailure?: (err:any) => boolean,
   *   onStateChange?: (from:string, to:string) => void}} opts
   *   `isFailure` lets callers ignore errors that prove the dependency is up
   *   (e.g. a 400 caused by our own payload).
   */
  constructor({ failureThreshold, resetTimeoutMs, now = Date.now, isFailure = () => true, onStateChange }) {
    this.failureThreshold = Math.max(1, failureThreshold);
    this.resetTimeoutMs = resetTimeoutMs;
    this.now = now;
    this.isFailure = isFailure;
    this.onStateChange = onStateChange;
    /** @type {'closed'|'open'|'half_open'} */
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.trialInFlight = false;
  }

  /** @param {'closed'|'open'|'half_open'} next */
  #transition(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.onStateChange?.(prev, next);
  }

  /** Current state, promoting open -> half_open once the reset timeout passes. */
  getState() {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.#transition('half_open');
    }
    return this.state;
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async exec(fn) {
    const state = this.getState();
    if (state === 'open') {
      throw new CircuitOpenError(this.resetTimeoutMs - (this.now() - this.openedAt));
    }
    if (state === 'half_open') {
      if (this.trialInFlight) throw new CircuitOpenError(0);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.#transition('closed');
      return result;
    } catch (err) {
      if (!this.isFailure(err)) {
        this.failures = 0;
        this.#transition('closed');
        throw err;
      }
      this.failures += 1;
      if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
        this.openedAt = this.now();
        this.#transition('open');
      }
      throw err;
    } finally {
      if (state === 'half_open') this.trialInFlight = false;
    }
  }

  snapshot() {
    return { state: this.getState(), consecutiveFailures: this.failures };
  }
}
