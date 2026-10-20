/**
 * HMAC-SHA256 webhook signatures.
 *
 * The sender computes `hex(HMAC_SHA256(secret, "<timestamp>.<raw body>"))`
 * and sends it as `X-Signature-256: sha256=<hex>` with
 * `X-Signature-Timestamp: <unix seconds>`. Signing the timestamp together
 * with the body stops an attacker from replaying an old request with a fresh
 * timestamp.
 * @module hmac
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature-256';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

/**
 * @param {string} secret
 * @param {string|number} timestamp
 * @param {Buffer|string} rawBody
 */
export function sign(secret, timestamp, rawBody) {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return `sha256=${mac.digest('hex')}`;
}

/**
 * @param {{secret:string, signature?:string, timestamp?:string, rawBody?:Buffer,
 *   toleranceSec:number, nowSec?:number}} input
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function verifySignature({ secret, signature, timestamp, rawBody, toleranceSec, nowSec }) {
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'malformed timestamp' };
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };
  if (!rawBody) return { ok: false, reason: 'missing body' };

  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const received = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
