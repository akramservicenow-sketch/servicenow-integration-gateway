/**
 * JSON Schema validation (Ajv) for inbound webhook payloads.
 * @module validator
 */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const load = (name) => JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export const validators = {
  monitoring: ajv.compile(load('monitoring-alert.schema.json')),
  hr: ajv.compile(load('hr-event.schema.json')),
};

/**
 * @param {'monitoring'|'hr'} kind
 * @param {unknown} payload
 * @returns {{valid:true} | {valid:false, errors:{path:string, message:string}[]}}
 */
export function validate(kind, payload) {
  const fn = validators[kind];
  if (fn(payload)) return { valid: true };
  const errors = (fn.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message:
      e.keyword === 'additionalProperties'
        ? `unexpected property "${e.params.additionalProperty}"`
        : (e.message ?? 'invalid'),
  }));
  return { valid: false, errors };
}
