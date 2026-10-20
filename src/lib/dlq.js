/**
 * Dead-letter queue for events that could not be delivered to ServiceNow.
 *
 * Entries hold the *mapped* ServiceNow payload (already PII-minimised), not
 * the raw webhook body, so the DLQ never stores more than ServiceNow would.
 * @module dlq
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @typedef {object} DlqEntry
 * @property {string} id
 * @property {string} createdAt
 * @property {string} route          e.g. "monitoring" | "hr"
 * @property {string} idempotencyKey
 * @property {string} correlationId
 * @property {string} reason
 * @property {number} attempts
 * @property {{target:string, table:string, record:object}} delivery  mapped ServiceNow payload + target
 */

export class MemoryDlq {
  constructor() {
    /** @type {Map<string, DlqEntry>} */
    this.entries = new Map();
  }

  /** @param {Omit<DlqEntry,'id'|'createdAt'|'attempts'> & {attempts?:number}} item */
  add(item) {
    /** @type {DlqEntry} */
    const entry = { id: randomUUID(), createdAt: new Date().toISOString(), attempts: 1, ...item };
    this.entries.set(entry.id, entry);
    this.persist();
    return entry;
  }

  list() {
    return [...this.entries.values()];
  }

  /** @param {string} id */
  get(id) {
    return this.entries.get(id);
  }

  /** @param {string} id */
  remove(id) {
    const ok = this.entries.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** @param {string} id @param {string} reason */
  markFailed(id, reason) {
    const e = this.entries.get(id);
    if (!e) return;
    e.attempts += 1;
    e.reason = reason;
    this.persist();
  }

  size() {
    return this.entries.size;
  }

  persist() {}
}

/**
 * File-backed DLQ: JSON Lines, rewritten on change. Good enough for a single
 * instance and easy to inspect with `jq`; use a queue service in production.
 */
export class FileDlq extends MemoryDlq {
  /** @param {string} file */
  constructor(file) {
    super();
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        this.entries.set(entry.id, entry);
      }
    }
  }

  persist() {
    if (!this.file) return; // called during super() before file is set
    const body = this.list().map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(this.file, body ? body + '\n' : '', { mode: 0o600 });
  }
}

/** @param {{mode:'memory'|'file', file:string}} cfg */
export function createDlq(cfg) {
  return cfg.mode === 'file' ? new FileDlq(cfg.file) : new MemoryDlq();
}
