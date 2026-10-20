/**
 * Mock ServiceNow instance for local development and tests.
 *
 * Implements just enough of the platform to exercise the gateway:
 *   POST  /oauth_token.do                 client_credentials grant
 *   GET   /api/now/table/:table           sysparm_query field=value[^field=value]
 *   POST  /api/now/table/:table
 *   PATCH /api/now/table/:table/:sys_id
 *   POST  /api/now/import/:staging_table  simulated transform map (coalesce on correlation id)
 *
 * Test hooks (not part of ServiceNow):
 *   POST /__mock/faults  {"failNext": 3, "status": 503, "retryAfter": 1}
 *   GET  /__mock/records/:table
 *   POST /__mock/reset
 *   GET  /__mock/health
 */
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';

const PREFIX = { incident: 'INC', sn_hr_core_case: 'HRC' };

/**
 * @param {{clientId?:string, clientSecret?:string, username?:string, password?:string}} [opts]
 */
export function createMockServiceNow(opts = {}) {
  const creds = {
    clientId: opts.clientId ?? 'mock-client-id',
    clientSecret: opts.clientSecret ?? 'mock-client-secret',
    username: opts.username ?? 'mock.integration',
    password: opts.password ?? 'mock-password',
  };
  const state = {
    /** @type {Record<string, any[]>} */
    tables: {},
    tokens: new Set(),
    counters: {},
    faults: { failNext: 0, status: 503, retryAfter: undefined },
    importSets: 0,
    requests: /** @type {{method:string, path:string, correlationId?:string}[]} */ ([]),
  };

  const sysId = () => randomBytes(16).toString('hex');
  const nextNumber = (table) => {
    state.counters[table] = (state.counters[table] ?? 10000) + 1;
    return `${PREFIX[table] ?? 'REC'}00${state.counters[table]}`;
  };
  const table = (name) => (state.tables[name] ??= []);
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    if (!req.path.startsWith('/__mock')) {
      state.requests.push({ method: req.method, path: req.path, correlationId: req.get('x-correlation-id') });
    }
    next();
  });

  // ---- test hooks ----------------------------------------------------------
  app.get('/__mock/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/__mock/faults', (req, res) => {
    Object.assign(state.faults, req.body);
    res.json(state.faults);
  });
  app.get('/__mock/records/:table', (req, res) => res.json({ result: table(req.params.table) }));
  app.post('/__mock/reset', (req, res) => {
    state.tables = {};
    state.faults = { failNext: 0, status: 503, retryAfter: undefined };
    state.requests = [];
    res.json({ ok: true });
  });

  // ---- fault injection -------------------------------------------------------
  app.use((req, res, next) => {
    if (req.path.startsWith('/__mock') || state.faults.failNext <= 0) return next();
    state.faults.failNext -= 1;
    if (state.faults.retryAfter) res.set('Retry-After', String(state.faults.retryAfter));
    return res.status(state.faults.status).json({ error: { message: 'Injected fault', detail: 'mock' } });
  });

  // ---- OAuth ------------------------------------------------------------------
  app.post('/oauth_token.do', (req, res) => {
    const { grant_type: grant, client_id: id, client_secret: secret } = req.body ?? {};
    if (grant !== 'client_credentials' || id !== creds.clientId || secret !== creds.clientSecret) {
      return res.status(401).json({ error: 'access_denied', error_description: 'invalid client' });
    }
    const token = randomUUID();
    state.tokens.add(token);
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 1799, scope: 'useraccount' });
  });

  // ---- auth for /api ----------------------------------------------------------
  app.use('/api', (req, res, next) => {
    const header = req.get('authorization') ?? '';
    if (header.startsWith('Bearer ') && state.tokens.has(header.slice(7))) return next();
    if (header.startsWith('Basic ')) {
      const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if (u === creds.username && p === creds.password) return next();
    }
    return res.status(401).json({ error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' } });
  });

  // ---- Table API --------------------------------------------------------------
  const matches = (record, query) =>
    !query ||
    query
      .split('^')
      .filter((c) => c && !c.startsWith('ORDERBY'))
      .every((cond) => {
        const [field, value] = cond.split('=');
        return String(record[field] ?? '') === value;
      });

  app.get('/api/now/table/:table', (req, res) => {
    const limit = Number(req.query.sysparm_limit ?? 10000);
    const fields = req.query.sysparm_fields ? String(req.query.sysparm_fields).split(',') : null;
    const rows = table(req.params.table)
      .filter((r) => matches(r, String(req.query.sysparm_query ?? '')))
      .slice(0, limit)
      .map((r) => (fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : r));
    res.json({ result: rows });
  });

  const insert = (tableName, fields) => {
    const record = {
      ...fields,
      sys_id: sysId(),
      number: nextNumber(tableName),
      state: fields.state ?? '1',
      active: 'true',
      sys_created_on: now(),
      sys_updated_on: now(),
    };
    table(tableName).push(record);
    return record;
  };
  const update = (record, fields) => {
    Object.assign(record, fields, { sys_updated_on: now() });
    if (['6', '7'].includes(String(record.state))) record.active = 'false';
    return record;
  };

  app.post('/api/now/table/:table', (req, res) => {
    res.status(201).json({ result: insert(req.params.table, req.body ?? {}) });
  });
  app.patch('/api/now/table/:table/:sysId', (req, res) => {
    const record = table(req.params.table).find((r) => r.sys_id === req.params.sysId);
    if (!record) return res.status(404).json({ error: { message: 'No Record found' } });
    return res.json({ result: update(record, req.body ?? {}) });
  });

  // ---- Import Set API (simulated transform map) -------------------------------
  // Mirrors servicenow/transform_map_onBefore.js: coalesce on correlation id,
  // ignore resolves without an open incident, resolve or update otherwise.
  app.post('/api/now/import/:staging', (req, res) => {
    const row = req.body ?? {};
    state.importSets += 1;
    const importSet = `ISET00${10000 + state.importSets}`;
    table(req.params.staging).push({ ...row, sys_id: sysId(), sys_import_set: importSet });
    const base = { transform_map: 'Monitoring Event to Incident', table: 'incident', display_name: 'number' };

    if (!row.u_correlation_id || !row.u_short_description) {
      return res.status(201).json({
        import_set: importSet,
        staging_table: req.params.staging,
        result: [{ ...base, status: 'error', status_message: 'u_correlation_id and u_short_description are required' }],
      });
    }
    const existing = table('incident').find((r) => r.correlation_id === row.u_correlation_id && r.active === 'true');
    const fields = {
      correlation_id: row.u_correlation_id,
      short_description: row.u_short_description,
      description: row.u_description,
      impact: row.u_impact,
      urgency: row.u_urgency,
      cmdb_ci: row.u_cmdb_ci,
      assignment_group: row.u_assignment_group || undefined,
      contact_type: 'monitoring',
    };
    let status;
    let record;
    if (row.u_state_action === 'resolve') {
      if (!existing) {
        status = 'ignored';
      } else {
        record = update(existing, { state: '6', close_code: 'Solution provided', close_notes: 'Auto-resolved by monitoring' });
        status = 'updated';
      }
    } else if (existing) {
      record = update(existing, { impact: fields.impact, urgency: fields.urgency, description: fields.description });
      status = 'updated';
    } else {
      record = insert('incident', fields);
      status = 'inserted';
    }
    return res.status(201).json({
      import_set: importSet,
      staging_table: req.params.staging,
      result: [
        {
          ...base,
          status,
          sys_id: record?.sys_id,
          display_value: record?.number,
          ...(status === 'ignored' ? { status_message: 'No open incident for correlation id' } : {}),
        },
      ],
    });
  });

  app.use((req, res) => res.status(400).json({ error: { message: 'Invalid URL', detail: req.path } }));
  return { app, state };
}
