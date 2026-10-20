/**
 * Express middleware: correlation ids, HMAC verification, admin auth, errors.
 * @module middleware
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '../lib/hmac.js';

const CORRELATION_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuse a well-formed inbound X-Correlation-ID or mint one; attach a child logger. */
export function correlation(logger) {
  return (req, res, next) => {
    const inbound = req.get('x-correlation-id');
    const id = inbound && CORRELATION_RE.test(inbound) ? inbound : randomUUID();
    req.correlationId = id;
    req.log = logger.child({ correlationId: id });
    res.set('X-Correlation-ID', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      req.log.info('request completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}

/** Reject requests whose HMAC signature does not match the raw body. */
export function requireSignature({ secret, toleranceSec }) {
  return (req, res, next) => {
    const result = verifySignature({
      secret,
      signature: req.get(SIGNATURE_HEADER),
      timestamp: req.get(TIMESTAMP_HEADER),
      rawBody: req.rawBody,
      toleranceSec,
    });
    if (!result.ok) {
      req.log.warn('signature rejected', { reason: result.reason });
      return res.status(401).json({ error: 'invalid_signature', correlationId: req.correlationId });
    }
    return next();
  };
}

/** Bearer-token guard for the admin API; the API is not mounted when no token is configured. */
export function requireAdmin(token) {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    const got = Buffer.from(req.get('authorization') ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

/** Final error handler: never leak stack traces or upstream bodies to callers. */
export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', correlationId: req.correlationId });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', correlationId: req.correlationId });
  }
  (req.log ?? console).error('unhandled error', { error: err });
  return res.status(500).json({ error: 'internal_error', correlationId: req.correlationId });
}
