/**
 * Retry with exponential backoff and full jitter.
 * @module retry
 */

/**
 * Error carrying an HTTP status (and optional Retry-After seconds) so the
 * retry policy can decide whether another attempt makes sense.
 */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {{retryAfterSec?: number, body?: unknown}} [extra]
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterSec = extra.retryAfterSec;
    this.body = extra.body;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Network failures, timeouts and 408/429/5xx are retryable; other 4xx are not
 * (a bad payload will not get better by resending it).
 * @param {any} err
 */
export function isRetryable(err) {
  if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status);
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  return err instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code);
}

/**
 * @param {number} attempt zero-based
 * @param {{baseMs:number, maxMs:number}} opts
 * @param {() => number} [random]
 */
export function backoffDelay(attempt, { baseMs, maxMs }, random = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2); // "equal jitter"
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{retries:number, baseMs:number, maxMs:number,
 *   shouldRetry?: (err:any) => boolean,
 *   onRetry?: (info:{attempt:number, delayMs:number, error:any}) => void,
 *   sleep?: (ms:number) => Promise<void>,
 *   random?: () => number}} opts
 * @returns {Promise<T>}
 */
export async function retry(fn, opts) {
  const shouldRetry = opts.shouldRetry ?? isRetryable;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !shouldRetry(err)) throw err;
      let delayMs = backoffDelay(attempt, opts, opts.random);
      if (err instanceof HttpError && err.retryAfterSec !== undefined) {
        delayMs = Math.min(err.retryAfterSec * 1000, opts.maxMs);
      }
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
