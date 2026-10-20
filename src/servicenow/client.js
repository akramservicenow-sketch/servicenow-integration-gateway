/**
 * ServiceNow REST client (Table API + Import Set API) built on global fetch.
 *
 * - OAuth client-credentials (token cached, refreshed once on 401) or basic auth
 * - per-request timeout via AbortSignal.timeout
 * - every call wrapped in retry (exponential backoff) inside a circuit breaker
 * - X-Correlation-ID forwarded so instance logs can be joined with gateway logs
 * @module servicenow/client
 */
import { CircuitBreaker } from '../lib/circuitBreaker.js';
import { HttpError, isRetryable, retry } from '../lib/retry.js';

const TABLE_RE = /^[a-z0-9_]{1,80}$/;

function assertTable(name) {
  if (!TABLE_RE.test(name)) throw new Error(`invalid table name "${name}"`);
}

/** Encoded-query values cannot contain ^ (the AND operator) or newlines. */
function q(value) {
  return String(value).replace(/[\^\r\n]/g, '');
}

export class ServiceNowClient {
  /**
   * @param {import('../config.js').GatewayConfig} cfg
   * @param {{logger?: import('../lib/logger.js').Logger, fetchImpl?: typeof fetch,
   *   sleep?: (ms:number)=>Promise<void>, breaker?: CircuitBreaker}} [deps]
   */
  constructor(cfg, deps = {}) {
    this.sn = cfg.servicenow;
    this.retryOpts = { ...cfg.retry, sleep: deps.sleep };
    this.logger = deps.logger;
    this.fetch = deps.fetchImpl ?? globalThis.fetch;
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        ...cfg.circuitBreaker,
        isFailure: isRetryable, // a 400/403 means the instance is up; do not trip
        onStateChange: (from, to) => this.logger?.warn('circuit breaker state change', { from, to }),
      });
    /** @type {{value:string, expiresAt:number} | null} */
    this.token = null;
  }

  async #getToken(force = false) {
    if (!force && this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.sn.clientId ?? '',
      client_secret: this.sn.clientSecret ?? '',
    });
    const res = await this.fetch(`${this.sn.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(this.sn.timeoutMs),
    });
    if (!res.ok) throw new HttpError(`OAuth token request failed (${res.status})`, res.status);
    const json = await res.json();
    if (!json.access_token) throw new HttpError('OAuth response missing access_token', 502);
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 1800) * 1000 };
    return this.token.value;
  }

  async #authHeader(force = false) {
    if (this.sn.authMode === 'basic') {
      const raw = Buffer.from(`${this.sn.username}:${this.sn.password}`).toString('base64');
      return `Basic ${raw}`;
    }
    return `Bearer ${await this.#getToken(force)}`;
  }

  /**
   * One HTTP exchange (no retry). Throws HttpError for non-2xx.
   * @param {string} method
   * @param {string} path
   * @param {{body?:object, correlationId?:string}} [opts]
   */
  async #once(method, path, { body, correlationId } = {}) {
    let refreshed = false;
    for (;;) {
      const headers = {
        Accept: 'application/json',
        Authorization: await this.#authHeader(refreshed),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(correlationId ? { 'X-Correlation-ID': correlationId } : {}),
      };
      const res = await this.fetch(`${this.sn.instanceUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.sn.timeoutMs),
      });
      if (res.status === 401 && this.sn.authMode === 'oauth' && !refreshed) {
        refreshed = true; // token expired or revoked; get a new one once
        continue;
      }
      const text = await res.text();
      const json = text ? safeJson(text) : {};
      if (!res.ok) {
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new HttpError(`ServiceNow ${method} ${path.split('?')[0]} -> ${res.status}`, res.status, {
          retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          body: json?.error ?? undefined,
        });
      }
      return json;
    }
  }

  /** Retry + breaker wrapper used by every public method. */
  async request(method, path, opts = {}) {
    return this.breaker.exec(() =>
      retry(() => this.#once(method, path, opts), {
        ...this.retryOpts,
        onRetry: ({ attempt, delayMs, error }) =>
          this.logger?.warn('retrying ServiceNow call', {
            correlationId: opts.correlationId,
            attempt,
            delayMs,
            status: error.status,
            error: error.message,
          }),
      }),
    );
  }

  /**
   * POST a row to an Import Set staging table; the instance's transform map
   * does the insert/update. Returns the first transform result.
   * @param {string} stagingTable
   * @param {object} row
   * @param {string} [correlationId]
   */
  async importRow(stagingTable, row, correlationId) {
    assertTable(stagingTable);
    const json = await this.request('POST', `/api/now/import/${stagingTable}`, { body: row, correlationId });
    const result = json.result?.[0] ?? {};
    if (result.status === 'error') {
      throw new HttpError(`transform error: ${result.status_message ?? 'unknown'}`, 422, { body: result });
    }
    return {
      action: result.status, // inserted | updated | ignored | skipped
      table: result.table,
      sys_id: result.sys_id,
      number: result.display_value,
      import_set: json.import_set,
    };
  }

  /**
   * Find an active record by a correlation field, then PATCH it or POST a new
   * one. Used for Table API mode and HR cases.
   * @param {string} table
   * @param {string} correlationField
   * @param {object} fields
   * @param {{correlationId?:string, resolve?:boolean}} [opts]
   */
  async upsertByCorrelation(table, correlationField, fields, opts = {}) {
    assertTable(table);
    const key = fields[correlationField];
    const query = encodeURIComponent(`${correlationField}=${q(key)}^active=true`);
    const found = await this.request(
      'GET',
      `/api/now/table/${table}?sysparm_query=${query}&sysparm_limit=1&sysparm_fields=sys_id,number,state`,
      { correlationId: opts.correlationId },
    );
    const existing = found.result?.[0];
    if (existing) {
      const patch = opts.resolve
        ? { ...fields, state: '6', close_code: 'Solution provided', close_notes: 'Auto-resolved by monitoring' }
        : fields;
      const res = await this.request('PATCH', `/api/now/table/${table}/${existing.sys_id}`, {
        body: patch,
        correlationId: opts.correlationId,
      });
      return { action: 'updated', table, sys_id: res.result.sys_id, number: res.result.number };
    }
    if (opts.resolve) return { action: 'ignored', table, reason: 'no open record to resolve' };
    const res = await this.request('POST', `/api/now/table/${table}`, { body: fields, correlationId: opts.correlationId });
    return { action: 'inserted', table, sys_id: res.result.sys_id, number: res.result.number };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
