/**
 * Configuration loaded from environment variables only.
 * Secrets are never logged; use `describeConfig()` for a redacted view.
 * @module config
 */

/**
 * @typedef {object} GatewayConfig
 * @property {number} port
 * @property {string} logLevel
 * @property {string} webhookSecret          HMAC key shared with the event source
 * @property {number} signatureToleranceSec  max clock skew for X-Signature-Timestamp
 * @property {string} bodyLimit
 * @property {object} servicenow
 * @property {string} servicenow.instanceUrl
 * @property {'oauth'|'basic'} servicenow.authMode
 * @property {string} [servicenow.clientId]
 * @property {string} [servicenow.clientSecret]
 * @property {string} [servicenow.username]
 * @property {string} [servicenow.password]
 * @property {'import_set'|'table'} servicenow.writeMode
 * @property {string} servicenow.importTable
 * @property {string} servicenow.incidentTable
 * @property {string} servicenow.hrCaseTable
 * @property {number} servicenow.timeoutMs
 * @property {{retries:number, baseMs:number, maxMs:number}} retry
 * @property {{failureThreshold:number, resetTimeoutMs:number}} circuitBreaker
 * @property {number} idempotencyTtlMs
 * @property {{mode:'memory'|'file', file:string}} dlq
 * @property {string} [adminToken]
 */

export class ConfigError extends Error {}

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new ConfigError(`expected a non-negative integer, got "${value}"`);
  return n;
};

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {GatewayConfig}
 */
export function loadConfig(env = process.env) {
  const required = (name) => {
    const v = env[name];
    if (!v) throw new ConfigError(`${name} is required`);
    return v;
  };

  const webhookSecret = required('WEBHOOK_SECRET');
  if (webhookSecret.length < 32) throw new ConfigError('WEBHOOK_SECRET must be at least 32 characters');

  const instanceUrl = required('SN_INSTANCE_URL').replace(/\/+$/, '');
  const allowHttp = env.SN_ALLOW_HTTP === 'true';
  if (!instanceUrl.startsWith('https://') && !allowHttp) {
    throw new ConfigError('SN_INSTANCE_URL must use https:// (set SN_ALLOW_HTTP=true only for the local mock)');
  }

  const authMode = (env.SN_AUTH_MODE || 'oauth').toLowerCase();
  if (authMode === 'oauth') {
    required('SN_CLIENT_ID');
    required('SN_CLIENT_SECRET');
  } else if (authMode === 'basic') {
    required('SN_USERNAME');
    required('SN_PASSWORD');
  } else {
    throw new ConfigError(`SN_AUTH_MODE must be oauth or basic, got "${authMode}"`);
  }

  const writeMode = (env.SN_WRITE_MODE || 'import_set').toLowerCase();
  if (!['import_set', 'table'].includes(writeMode)) {
    throw new ConfigError(`SN_WRITE_MODE must be import_set or table, got "${writeMode}"`);
  }

  const dlqMode = (env.DLQ_MODE || 'memory').toLowerCase();
  if (!['memory', 'file'].includes(dlqMode)) throw new ConfigError('DLQ_MODE must be memory or file');

  return {
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || 'info',
    webhookSecret,
    signatureToleranceSec: int(env.SIGNATURE_TOLERANCE_SEC, 300),
    bodyLimit: env.BODY_LIMIT || '100kb',
    servicenow: {
      instanceUrl,
      authMode: /** @type {'oauth'|'basic'} */ (authMode),
      clientId: env.SN_CLIENT_ID,
      clientSecret: env.SN_CLIENT_SECRET,
      username: env.SN_USERNAME,
      password: env.SN_PASSWORD,
      writeMode: /** @type {'import_set'|'table'} */ (writeMode),
      importTable: env.SN_IMPORT_TABLE || 'u_monitoring_event_import',
      incidentTable: env.SN_INCIDENT_TABLE || 'incident',
      hrCaseTable: env.SN_HR_CASE_TABLE || 'sn_hr_core_case',
      timeoutMs: int(env.SN_TIMEOUT_MS, 10000),
    },
    retry: {
      retries: int(env.RETRY_MAX, 4),
      baseMs: int(env.RETRY_BASE_MS, 250),
      maxMs: int(env.RETRY_MAX_MS, 8000),
    },
    circuitBreaker: {
      failureThreshold: int(env.CB_FAILURE_THRESHOLD, 5),
      resetTimeoutMs: int(env.CB_RESET_MS, 30000),
    },
    idempotencyTtlMs: int(env.IDEMPOTENCY_TTL_MS, 24 * 60 * 60 * 1000),
    dlq: {
      mode: /** @type {'memory'|'file'} */ (dlqMode),
      file: env.DLQ_FILE || './data/dlq.jsonl',
    },
    adminToken: env.ADMIN_TOKEN || undefined,
  };
}

/**
 * Redacted summary safe to log at startup.
 * @param {GatewayConfig} cfg
 */
export function describeConfig(cfg) {
  return {
    port: cfg.port,
    instanceUrl: cfg.servicenow.instanceUrl,
    authMode: cfg.servicenow.authMode,
    writeMode: cfg.servicenow.writeMode,
    importTable: cfg.servicenow.importTable,
    hrCaseTable: cfg.servicenow.hrCaseTable,
    retry: cfg.retry,
    circuitBreaker: cfg.circuitBreaker,
    dlq: cfg.dlq.mode,
    adminApi: Boolean(cfg.adminToken),
  };
}
