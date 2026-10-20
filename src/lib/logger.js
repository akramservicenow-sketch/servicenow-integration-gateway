/**
 * Minimal structured JSON logger with child bindings and secret redaction.
 * One JSON object per line keeps logs friendly to any log shipper.
 * @module logger
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT = /secret|password|token|authorization|signature|cookie|api[_-]?key/i;

/**
 * Recursively replace values whose key looks sensitive.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * @typedef {object} Logger
 * @property {(msg: string, fields?: object) => void} debug
 * @property {(msg: string, fields?: object) => void} info
 * @property {(msg: string, fields?: object) => void} warn
 * @property {(msg: string, fields?: object) => void} error
 * @property {(bindings: object) => Logger} child
 */

/**
 * @param {{level?: string, service?: string, bindings?: object, write?: (line: string) => void}} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const threshold = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
  const write = opts.write ?? ((line) => process.stdout.write(line + '\n'));
  const bindings = { service: opts.service ?? 'sn-gateway', ...opts.bindings };

  const log = (level) => (msg, fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...bindings, ...redact(fields) };
    write(JSON.stringify(entry));
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (extra) => createLogger({ ...opts, bindings: { ...bindings, ...extra } }),
  };
}
