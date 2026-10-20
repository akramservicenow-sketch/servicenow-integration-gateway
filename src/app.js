/**
 * Express application factory. All collaborators are injectable so tests can
 * run the full HTTP pipeline against the mock ServiceNow server.
 * @module app
 */
import express from 'express';
import { createDlq } from './lib/dlq.js';
import { IdempotencyStore } from './lib/idempotency.js';
import { createLogger } from './lib/logger.js';
import { validate } from './lib/validator.js';
import { correlation, errorHandler, requireAdmin, requireSignature } from './middleware/index.js';
import { buildDelivery, deliver } from './processor.js';
import { ServiceNowClient } from './servicenow/client.js';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * @param {import('./config.js').GatewayConfig} cfg
 * @param {{logger?: any, client?: ServiceNowClient, dlq?: any, idempotency?: IdempotencyStore,
 *   fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>}} [deps]
 */
export function createApp(cfg, deps = {}) {
  const logger = deps.logger ?? createLogger({ level: cfg.logLevel });
  const client = deps.client ?? new ServiceNowClient(cfg, { logger, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
  const dlq = deps.dlq ?? createDlq(cfg.dlq);
  const idempotency = deps.idempotency ?? new IdempotencyStore({ ttlMs: cfg.idempotencyTtlMs });
  const startedAt = Date.now();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.locals = { ...app.locals, client, dlq, idempotency, logger };

  app.use(correlation(logger));

  // ---- health ------------------------------------------------------------------
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      circuit: client.breaker.snapshot(),
      dlqDepth: dlq.size(),
    });
  });
  app.get('/ready', (req, res) => {
    const state = client.breaker.getState();
    res.status(state === 'open' ? 503 : 200).json({ ready: state !== 'open', circuit: state });
  });

  // ---- webhooks ----------------------------------------------------------------
  const jsonWithRaw = express.json({
    limit: cfg.bodyLimit,
    type: 'application/json',
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf); // HMAC must be computed over the exact bytes received
    },
  });
  const signed = requireSignature({ secret: cfg.webhookSecret, toleranceSec: cfg.signatureToleranceSec });

  /** @param {'monitoring'|'hr'} route */
  const handler = (route) => async (req, res) => {
    const log = req.log.child({ route });
    const check = validate(route, req.body);
    if (!check.valid) {
      log.warn('schema validation failed', { errors: check.errors });
      return res.status(400).json({ error: 'validation_failed', details: check.errors, correlationId: req.correlationId });
    }

    const headerKey = req.get('idempotency-key');
    if (headerKey !== undefined && !IDEMPOTENCY_KEY_RE.test(headerKey)) {
      return res.status(400).json({ error: 'invalid_idempotency_key', correlationId: req.correlationId });
    }
    const key = `${route}:${headerKey || req.body.event_id}`;
    const claim = idempotency.claim(key);
    if (!claim.claimed) {
      if (claim.entry.state === 'in_flight') {
        return res.status(409).json({ error: 'in_progress', idempotencyKey: key, correlationId: req.correlationId });
      }
      log.info('duplicate event', { idempotencyKey: key });
      return res.status(200).json({ ...claim.entry.result, duplicate: true, correlationId: req.correlationId });
    }

    const delivery = buildDelivery(route, req.body, cfg);
    try {
      const outcome = await deliver(client, delivery, req.correlationId);
      const result = { status: 'delivered', ...outcome };
      idempotency.complete(key, result);
      log.info('delivered to ServiceNow', { action: outcome.action, table: outcome.table, number: outcome.number });
      return res.status(outcome.action === 'inserted' ? 201 : 200).json({ ...result, correlationId: req.correlationId });
    } catch (err) {
      const entry = dlq.add({
        route,
        idempotencyKey: key,
        correlationId: req.correlationId,
        reason: `${err.name}: ${err.message}`,
        delivery,
      });
      const result = { status: 'queued', dlqId: entry.id, reason: err.name };
      idempotency.complete(key, result); // sender retries are absorbed; ops replays from the DLQ
      log.error('delivery failed; sent to DLQ', { dlqId: entry.id, error: err, status: err.status });
      return res.status(202).json({ ...result, correlationId: req.correlationId });
    }
  };

  const requireJson = (req, res, next) =>
    req.is('application/json')
      ? next()
      : res.status(415).json({ error: 'unsupported_media_type', correlationId: req.correlationId });

  app.post('/webhooks/monitoring', requireJson, jsonWithRaw, signed, handler('monitoring'));
  app.post('/webhooks/hr', requireJson, jsonWithRaw, signed, handler('hr'));

  // ---- admin (DLQ inspection and replay) ------------------------------------
  if (cfg.adminToken) {
    const admin = express.Router();
    admin.use(requireAdmin(cfg.adminToken));
    admin.get('/dlq', (req, res) => {
      res.json({
        count: dlq.size(),
        entries: dlq.list().map(({ delivery, ...meta }) => ({ ...meta, table: delivery.table, target: delivery.target })),
      });
    });
    admin.post('/dlq/:id/replay', async (req, res) => {
      const entry = dlq.get(req.params.id);
      if (!entry) return res.status(404).json({ error: 'not_found' });
      try {
        const outcome = await deliver(client, entry.delivery, entry.correlationId);
        dlq.remove(entry.id);
        idempotency.complete(entry.idempotencyKey, { status: 'delivered', ...outcome });
        req.log.info('DLQ entry replayed', { dlqId: entry.id, originalCorrelationId: entry.correlationId });
        return res.json({ status: 'delivered', ...outcome });
      } catch (err) {
        dlq.markFailed(entry.id, `${err.name}: ${err.message}`);
        return res.status(502).json({ status: 'failed', reason: err.name });
      }
    });
    app.use('/admin', admin);
  }

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
