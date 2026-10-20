/**
 * End-to-end tests: supertest drives the gateway, which talks over real HTTP
 * to the mock ServiceNow on 127.0.0.1. No external network is used.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { ADMIN_TOKEN, alert, buildGateway, hrEvent, signed, startMock } from './helpers.js';

let mock;
before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});
beforeEach(async () => {
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
});

const injectFaults = (body) =>
  fetch(`${mock.url}/__mock/faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const post = (app, path, payload, opts) => {
  const [headers, body] = signed(payload, opts);
  return request(app).post(path).set(headers).send(body);
};

describe('monitoring webhook via Import Set API', () => {
  it('creates an incident through the staging table and transform', async () => {
    const { app } = buildGateway(mock.url);
    const res = await post(app, '/webhooks/monitoring', alert({ severity: 'critical' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'inserted');
    assert.match(res.body.number, /^INC/);
    assert.match(res.body.import_set, /^ISET/);
    assert.ok(res.headers['x-correlation-id']);
    const staged = mock.state.tables.u_monitoring_event_import;
    assert.equal(staged.length, 1);
    assert.equal(mock.state.tables.incident[0].impact, '1');
  });

  it('updates the same incident for repeat alerts and resolves it on recovery', async () => {
    const { app } = buildGateway(mock.url);
    const first = await post(app, '/webhooks/monitoring', alert());
    const again = await post(app, '/webhooks/monitoring', alert({ severity: 'critical' }));
    const resolved = await post(app, '/webhooks/monitoring', alert({ status: 'resolved', severity: 'info' }));
    assert.equal(again.body.action, 'updated');
    assert.equal(resolved.body.action, 'updated');
    assert.equal(first.body.sys_id, resolved.body.sys_id);
    const [incident] = mock.state.tables.incident;
    assert.equal(incident.state, '6');
    assert.equal(incident.active, 'false');
    assert.equal(mock.state.tables.incident.length, 1);
  });

  it('deduplicates by event id and by Idempotency-Key header', async () => {
    const { app } = buildGateway(mock.url);
    const payload = alert();
    const a = await post(app, '/webhooks/monitoring', payload);
    const b = await post(app, '/webhooks/monitoring', payload);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.duplicate, true);
    assert.equal(b.body.number, a.body.number);
    assert.equal(mock.state.tables.u_monitoring_event_import.length, 1);

    const [headers, body] = signed(alert());
    const c = await request(app).post('/webhooks/monitoring').set({ ...headers, 'Idempotency-Key': 'retry-42' }).send(body);
    const [headers2, body2] = signed(alert()); // different event id, same key
    const d = await request(app).post('/webhooks/monitoring').set({ ...headers2, 'Idempotency-Key': 'retry-42' }).send(body2);
    assert.equal(c.status, 200); // updates the existing incident (same correlation key)
    assert.equal(d.body.duplicate, true);
  });

  it('forwards the correlation id to ServiceNow', async () => {
    const { app } = buildGateway(mock.url);
    const [headers, body] = signed(alert());
    await request(app).post('/webhooks/monitoring').set({ ...headers, 'X-Correlation-ID': 'corr-test-0001' }).send(body);
    const importCall = mock.state.requests.find((r) => r.path.startsWith('/api/now/import/'));
    assert.equal(importCall.correlationId, 'corr-test-0001');
  });
});

describe('monitoring webhook via Table API', () => {
  it('upserts on correlation_id and ignores resolves with no open incident', async () => {
    const { app } = buildGateway(mock.url, { SN_WRITE_MODE: 'table', SN_AUTH_MODE: 'basic', SN_USERNAME: 'mock.integration', SN_PASSWORD: 'mock-password' });
    const ignored = await post(app, '/webhooks/monitoring', alert({ host: 'other-host', status: 'resolved' }));
    assert.equal(ignored.body.action, 'ignored');
    const created = await post(app, '/webhooks/monitoring', alert());
    assert.equal(created.status, 201);
    const resolved = await post(app, '/webhooks/monitoring', alert({ status: 'resolved' }));
    assert.equal(resolved.body.action, 'updated');
    assert.equal(mock.state.tables.incident[0].close_code, 'Solution provided');
  });
});

describe('HR webhook', () => {
  it('creates an HR case with only the employee number and org codes', async () => {
    const { app } = buildGateway(mock.url);
    const res = await post(app, '/webhooks/hr', hrEvent());
    assert.equal(res.status, 201);
    assert.match(res.body.number, /^HRC/);
    const [hrCase] = mock.state.tables.sn_hr_core_case;
    assert.equal(hrCase.u_subject_employee_number, 'E-100482');
    assert.equal(hrCase.u_hr_service_name, 'Onboarding');
  });
});

describe('request rejection', () => {
  it('rejects bad signatures with 401 and never calls ServiceNow', async () => {
    const { app } = buildGateway(mock.url);
    const res = await post(app, '/webhooks/monitoring', alert(), { secret: 'wrong-secret-wrong-secret-wrong-secret' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');
    assert.equal(mock.state.requests.length, 0);
  });

  it('rejects schema violations with 400 and field details', async () => {
    const { app } = buildGateway(mock.url);
    const res = await post(app, '/webhooks/monitoring', alert({ severity: 'apocalyptic', extra: 1 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'validation_failed');
    assert.ok(res.body.details.length >= 2);
  });

  it('rejects non-JSON, malformed JSON, oversized bodies and bad idempotency keys', async () => {
    const { app } = buildGateway(mock.url, { BODY_LIMIT: '1kb' });
    const text = await request(app).post('/webhooks/monitoring').set('Content-Type', 'text/plain').send('hi');
    assert.equal(text.status, 415);
    const broken = await request(app).post('/webhooks/monitoring').set('Content-Type', 'application/json').send('{"a":');
    assert.equal(broken.status, 400);
    const big = await post(app, '/webhooks/monitoring', alert({ description: 'x'.repeat(3000) }));
    assert.equal(big.status, 413);
    const [headers, body] = signed(alert());
    const badKey = await request(app).post('/webhooks/monitoring').set({ ...headers, 'Idempotency-Key': 'has spaces' }).send(body);
    assert.equal(badKey.status, 400);
  });
});

describe('resilience', () => {
  it('retries transient 503s and still delivers', async () => {
    const { app, logs } = buildGateway(mock.url);
    await injectFaults({ failNext: 2, status: 503 });
    const res = await post(app, '/webhooks/monitoring', alert());
    assert.equal(res.status, 201);
    assert.equal(logs.filter((l) => l.msg === 'retrying ServiceNow call').length, 2);
  });

  it('sends to the DLQ when retries are exhausted, then replays via the admin API', async () => {
    const { app } = buildGateway(mock.url);
    await injectFaults({ failNext: 10, status: 503 });
    const res = await post(app, '/webhooks/monitoring', alert());
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'queued');
    await injectFaults({ failNext: 0 });

    const list = await request(app).get('/admin/dlq').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(list.body.count, 1);
    assert.equal(list.body.entries[0].table, 'u_monitoring_event_import');
    assert.equal(list.body.entries[0].record, undefined); // payload not exposed in listing

    const replay = await request(app).post(`/admin/dlq/${res.body.dlqId}/replay`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.action, 'inserted');
    const health = await request(app).get('/health');
    assert.equal(health.body.dlqDepth, 0);
  });

  it('opens the circuit after repeated failures and reports not-ready', async () => {
    const { app } = buildGateway(mock.url, { RETRY_MAX: '0', CB_FAILURE_THRESHOLD: '2' });
    await injectFaults({ failNext: 100, status: 502 });
    await post(app, '/webhooks/monitoring', alert());
    await post(app, '/webhooks/monitoring', alert());
    const before = mock.state.requests.length;
    const third = await post(app, '/webhooks/monitoring', alert());
    assert.equal(third.status, 202);
    assert.equal(third.body.reason, 'CircuitOpenError');
    assert.equal(mock.state.requests.length, before); // failed fast, no call made
    const ready = await request(app).get('/ready');
    assert.equal(ready.status, 503);
    const health = await request(app).get('/health');
    assert.equal(health.body.circuit.state, 'open');
    assert.equal(health.body.dlqDepth, 3);
  });

  it('does not retry or trip the breaker on a 4xx from ServiceNow', async () => {
    const { app } = buildGateway(mock.url, { CB_FAILURE_THRESHOLD: '1' });
    await injectFaults({ failNext: 2, status: 403 }); // token call + nothing else
    const res = await post(app, '/webhooks/monitoring', alert());
    assert.equal(res.status, 202);
    const health = await request(app).get('/health');
    assert.equal(health.body.circuit.state, 'closed');
  });
});

describe('operational endpoints', () => {
  it('serves health and protects the admin API', async () => {
    const { app } = buildGateway(mock.url);
    const health = await request(app).get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    const noAuth = await request(app).get('/admin/dlq');
    assert.equal(noAuth.status, 401);
    const wrong = await request(app).get('/admin/dlq').set('Authorization', 'Bearer nope');
    assert.equal(wrong.status, 401);
  });

  it('does not mount the admin API without ADMIN_TOKEN', async () => {
    const { app } = buildGateway(mock.url, { ADMIN_TOKEN: '' });
    const res = await request(app).get('/admin/dlq');
    assert.equal(res.status, 404);
  });

  it('logs structured JSON with correlation ids and no secrets', async () => {
    const { app, logs } = buildGateway(mock.url);
    await post(app, '/webhooks/monitoring', alert());
    const done = logs.find((l) => l.msg === 'request completed');
    assert.ok(done.correlationId);
    assert.equal(done.status, 201);
    const all = JSON.stringify(logs);
    assert.ok(!all.includes('mock-client-secret'));
    assert.ok(!all.includes('sha256='));
  });
});
