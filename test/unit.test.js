import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { CircuitBreaker, CircuitOpenError } from '../src/lib/circuitBreaker.js';
import { FileDlq, MemoryDlq } from '../src/lib/dlq.js';
import { sign, verifySignature } from '../src/lib/hmac.js';
import { IdempotencyStore } from '../src/lib/idempotency.js';
import { createLogger, redact } from '../src/lib/logger.js';
import { backoffDelay, HttpError, isRetryable, retry } from '../src/lib/retry.js';
import { validate } from '../src/lib/validator.js';
import { toHrCaseFields } from '../src/mapping/hr.js';
import { correlationKey, toImportSetRow, toIncidentFields } from '../src/mapping/monitoring.js';
import { alert, baseEnv, hrEvent, WEBHOOK_SECRET } from './helpers.js';

describe('hmac', () => {
  const body = Buffer.from('{"a":1}');
  const ts = '1760000000';
  const sig = sign(WEBHOOK_SECRET, ts, body);
  const base = { secret: WEBHOOK_SECRET, rawBody: body, timestamp: ts, toleranceSec: 300, nowSec: 1760000010 };

  it('accepts a valid signature', () => {
    assert.deepEqual(verifySignature({ ...base, signature: sig }), { ok: true });
  });
  it('rejects a tampered body', () => {
    const r = verifySignature({ ...base, signature: sig, rawBody: Buffer.from('{"a":2}') });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'signature mismatch');
  });
  it('rejects stale timestamps (replay protection)', () => {
    const r = verifySignature({ ...base, signature: sig, nowSec: 1760000000 + 301 });
    assert.equal(r.reason, 'timestamp outside tolerance');
  });
  it('rejects missing headers and wrong-length signatures without throwing', () => {
    assert.equal(verifySignature({ ...base, signature: undefined }).ok, false);
    assert.equal(verifySignature({ ...base, signature: 'sha256=abc' }).reason, 'signature mismatch');
  });
});

describe('schema validation', () => {
  it('accepts a valid monitoring alert', () => {
    assert.equal(validate('monitoring', alert()).valid, true);
  });
  it('reports missing fields and bad enums', () => {
    const { severity: _omit, ...noSeverity } = alert();
    const r = validate('monitoring', { ...noSeverity, status: 'exploded' });
    assert.equal(r.valid, false);
    const messages = r.errors.map((e) => `${e.path} ${e.message}`).join('|');
    assert.match(messages, /severity/);
    assert.match(messages, /\/status/);
  });
  it('rejects personal data fields on HR events', () => {
    const r = validate('hr', hrEvent({ employee: { employee_number: 'E-1001', date_of_birth: '1990-01-01' } }));
    assert.equal(r.valid, false);
    assert.match(r.errors[0].message, /unexpected property "date_of_birth"/);
  });
});

describe('mapping', () => {
  it('maps severity to impact/urgency and firing to open', () => {
    const row = toImportSetRow(alert({ severity: 'critical' }));
    assert.equal(row.u_impact, '1');
    assert.equal(row.u_urgency, '1');
    assert.equal(row.u_state_action, 'open');
    assert.match(row.u_short_description, /^\[CRITICAL\] srvlx014/);
  });
  it('uses a stable correlation key per source+host+check', () => {
    const a = alert({ event_id: 'e1' });
    const b = alert({ event_id: 'e2', status: 'resolved' });
    assert.equal(correlationKey(a), correlationKey(b));
    assert.equal(toImportSetRow(b).u_state_action, 'resolve');
  });
  it('produces Table API incident fields', () => {
    const fields = toIncidentFields(alert({ assignment_group: 'grp-linux-ops' }));
    assert.equal(fields.contact_type, 'monitoring');
    assert.equal(fields.assignment_group, 'grp-linux-ops');
    assert.ok(fields.correlation_id);
  });
  it('maps HR events to a case referencing only the employee number', () => {
    const fields = toHrCaseFields(hrEvent());
    assert.equal(fields.u_hr_service_name, 'Onboarding');
    assert.equal(fields.u_subject_employee_number, 'E-100482');
    assert.match(fields.short_description, /E-100482/);
  });
});

describe('retry', () => {
  const opts = { retries: 3, baseMs: 100, maxMs: 1000, random: () => 0.5 };

  it('retries retryable errors then succeeds', async () => {
    const sleeps = [];
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError('busy', 503);
        return 'ok';
      },
      { ...opts, sleep: async (ms) => sleeps.push(ms) },
    );
    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [75, 150]); // equal-jitter backoff, doubling
  });
  it('does not retry client errors', async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls += 1;
        throw new HttpError('bad', 400);
      }, { ...opts, sleep: async () => {} }),
      /bad/,
    );
    assert.equal(calls, 1);
  });
  it('honours Retry-After and gives up after the retry budget', async () => {
    const sleeps = [];
    await assert.rejects(
      retry(async () => {
        throw new HttpError('slow down', 429, { retryAfterSec: 0.2 });
      }, { ...opts, sleep: async (ms) => sleeps.push(ms) }),
      /slow down/,
    );
    assert.deepEqual(sleeps, [200, 200, 200]);
  });
  it('classifies errors and caps delay', () => {
    assert.equal(isRetryable(new TypeError('fetch failed')), true);
    assert.equal(isRetryable(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
    assert.equal(isRetryable(new HttpError('x', 404)), false);
    assert.ok(backoffDelay(20, { baseMs: 100, maxMs: 1000 }) <= 1000);
  });
});

describe('circuit breaker', () => {
  const fail = () => Promise.reject(new Error('down'));
  const ok = () => Promise.resolve('up');

  it('opens after the failure threshold and fails fast', async () => {
    const t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => t });
    await assert.rejects(cb.exec(fail));
    await assert.rejects(cb.exec(fail));
    assert.equal(cb.getState(), 'open');
    let called = false;
    await assert.rejects(
      cb.exec(async () => {
        called = true;
      }),
      CircuitOpenError,
    );
    assert.equal(called, false);
  });
  it('half-opens after the reset timeout, closes on success, re-opens on failure', async () => {
    let t = 0;
    const transitions = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => t,
      onStateChange: (a, b) => transitions.push(`${a}->${b}`),
    });
    await assert.rejects(cb.exec(fail));
    t = 1000;
    assert.equal(cb.getState(), 'half_open');
    await assert.rejects(cb.exec(fail));
    assert.equal(cb.getState(), 'open');
    t = 2500;
    assert.equal(await cb.exec(ok), 'up');
    assert.deepEqual(transitions, ['closed->open', 'open->half_open', 'half_open->open', 'open->half_open', 'half_open->closed']);
  });
  it('ignores errors the predicate says are not dependency failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, isFailure: isRetryable });
    await assert.rejects(cb.exec(() => Promise.reject(new HttpError('bad request', 400))));
    assert.equal(cb.getState(), 'closed');
  });
});

describe('idempotency store', () => {
  it('claims once, returns completed results, and expires', () => {
    let t = 0;
    const store = new IdempotencyStore({ ttlMs: 100, now: () => t });
    assert.equal(store.claim('k').claimed, true);
    assert.equal(store.claim('k').entry.state, 'in_flight');
    store.complete('k', { number: 'INC1' });
    assert.deepEqual(store.claim('k').entry.result, { number: 'INC1' });
    t = 200;
    assert.equal(store.claim('k').claimed, true);
  });
  it('evicts oldest keys beyond maxEntries', () => {
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 2 });
    store.claim('a');
    store.claim('b');
    store.claim('c');
    assert.equal(store.size(), 2);
    assert.equal(store.claim('a').claimed, true);
  });
});

describe('dead-letter queue', () => {
  const item = { route: 'monitoring', idempotencyKey: 'k', correlationId: 'c', reason: 'r', delivery: { target: 'table', table: 'incident', record: {} } };

  it('memory DLQ supports add/list/markFailed/remove', () => {
    const dlq = new MemoryDlq();
    const e = dlq.add(item);
    dlq.markFailed(e.id, 'again');
    assert.equal(dlq.get(e.id).attempts, 2);
    assert.equal(dlq.remove(e.id), true);
    assert.equal(dlq.size(), 0);
  });
  it('file DLQ persists across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dlq-')), 'nested', 'dlq.jsonl');
    const first = new FileDlq(file);
    const e = first.add(item);
    assert.match(readFileSync(file, 'utf8'), new RegExp(e.id));
    const second = new FileDlq(file);
    assert.equal(second.get(e.id).reason, 'r');
    second.remove(e.id);
    assert.equal(new FileDlq(file).size(), 0);
  });
});

describe('logger', () => {
  it('writes JSON lines with bindings and redacts secrets', () => {
    const lines = [];
    const log = createLogger({ level: 'info', write: (l) => lines.push(JSON.parse(l)) }).child({ correlationId: 'abc' });
    log.debug('hidden');
    log.info('hello', { headers: { authorization: 'Bearer xyz' }, client_secret: 'x', ok: 1 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].correlationId, 'abc');
    assert.equal(lines[0].headers.authorization, '[REDACTED]');
    assert.equal(lines[0].client_secret, '[REDACTED]');
    assert.equal(lines[0].ok, 1);
    assert.deepEqual(redact(new Error('boom')), { name: 'Error', message: 'boom' });
  });
});

describe('config', () => {
  it('loads defaults and redacts on describe', () => {
    const cfg = loadConfig(baseEnv('https://example.service-now.com', { SN_ALLOW_HTTP: undefined }));
    assert.equal(cfg.servicenow.writeMode, 'import_set');
    const text = JSON.stringify(describeConfig(cfg));
    assert.ok(!text.includes(WEBHOOK_SECRET));
    assert.ok(!text.includes('mock-client-secret'));
  });
  it('rejects weak secrets, plain http, and bad modes', () => {
    const env = baseEnv('https://example.service-now.com');
    assert.throws(() => loadConfig({ ...env, WEBHOOK_SECRET: 'short' }), ConfigError);
    assert.throws(() => loadConfig({ ...env, SN_INSTANCE_URL: 'http://x', SN_ALLOW_HTTP: 'false' }), /https/);
    assert.throws(() => loadConfig({ ...env, SN_WRITE_MODE: 'soap' }), /SN_WRITE_MODE/);
    assert.throws(() => loadConfig({ ...env, SN_AUTH_MODE: 'basic' }), /SN_USERNAME/);
  });
});
