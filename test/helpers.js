import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sign } from '../src/lib/hmac.js';
import { createLogger } from '../src/lib/logger.js';
import { createMockServiceNow } from '../mock-servicenow/app.js';

export const WEBHOOK_SECRET = 'unit-test-webhook-key-0123456789abcdef'; // test-only placeholder
export const ADMIN_TOKEN = 'unit-test-admin-token';

/** Start the mock ServiceNow on an ephemeral port. */
export async function startMock() {
  const mock = createMockServiceNow();
  const server = await new Promise((resolve) => {
    const s = mock.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return { ...mock, server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export function baseEnv(url, overrides = {}) {
  return {
    WEBHOOK_SECRET,
    SN_INSTANCE_URL: url,
    SN_ALLOW_HTTP: 'true',
    SN_AUTH_MODE: 'oauth',
    SN_CLIENT_ID: 'mock-client-id',
    SN_CLIENT_SECRET: 'mock-client-secret',
    RETRY_MAX: '2',
    RETRY_BASE_MS: '1',
    RETRY_MAX_MS: '5',
    CB_FAILURE_THRESHOLD: '3',
    CB_RESET_MS: '60000',
    ADMIN_TOKEN,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** Build a gateway app wired to the mock, with captured logs. */
export function buildGateway(url, overrides = {}) {
  const cfg = loadConfig(baseEnv(url, overrides));
  const lines = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  const app = createApp(cfg, { logger, sleep: async () => {} });
  return { app, cfg, logs: lines };
}

/** Sign a payload; returns [headers, body] ready for supertest. */
export function signed(payload, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  return [
    {
      'Content-Type': 'application/json',
      'X-Signature-Timestamp': String(ts),
      'X-Signature-256': sign(secret, ts, body),
    },
    body,
  ];
}

export function alert(overrides = {}) {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    source: 'synthetic-monitor',
    host: 'srvlx014.example.internal',
    check: 'disk_usage_root',
    severity: 'major',
    status: 'firing',
    summary: 'Root filesystem above 92%',
    occurred_at: '2026-10-19T14:05:00Z',
    ...overrides,
  };
}

export function hrEvent(overrides = {}) {
  return {
    event_id: `hr-${Math.random().toString(36).slice(2, 10)}`,
    event_type: 'employee.onboarding',
    effective_date: '2026-11-02',
    employee: { employee_number: 'E-100482', department_code: 'FIN-OPS' },
    ...overrides,
  };
}
