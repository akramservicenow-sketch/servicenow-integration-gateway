#!/usr/bin/env node
/**
 * Sign a JSON payload the way an event source would, and print curl headers.
 *
 *   WEBHOOK_SECRET=... node scripts/sign-payload.js examples/monitoring-alert.json
 *
 * Prints three lines: timestamp header, signature header, and the compact body
 * (sign and send the exact same bytes).
 */
import { readFileSync } from 'node:fs';
import { sign } from '../src/lib/hmac.js';

const [file] = process.argv.slice(2);
const secret = process.env.WEBHOOK_SECRET;
if (!file || !secret) {
  process.stderr.write('usage: WEBHOOK_SECRET=... node scripts/sign-payload.js <payload.json>\n');
  process.exit(1);
}
const body = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
const ts = Math.floor(Date.now() / 1000);
process.stdout.write(`X-Signature-Timestamp: ${ts}\nX-Signature-256: ${sign(secret, ts, body)}\n${body}\n`);
