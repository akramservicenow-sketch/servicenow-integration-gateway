/**
 * Delivery logic shared by the webhook routes and DLQ replay.
 * @module processor
 */
import { toHrCaseFields } from './mapping/hr.js';
import { toImportSetRow, toIncidentFields } from './mapping/monitoring.js';

/**
 * Build the ServiceNow-bound record for a validated payload.
 * @param {'monitoring'|'hr'} route
 * @param {any} payload
 * @param {import('./config.js').GatewayConfig} cfg
 * @returns {{target:'import_set'|'table', table:string, record:object, resolve?:boolean, correlationField?:string}}
 */
export function buildDelivery(route, payload, cfg) {
  const sn = cfg.servicenow;
  if (route === 'hr') {
    return { target: 'table', table: sn.hrCaseTable, record: toHrCaseFields(payload), correlationField: 'u_correlation_id' };
  }
  if (sn.writeMode === 'import_set') {
    return { target: 'import_set', table: sn.importTable, record: toImportSetRow(payload) };
  }
  return {
    target: 'table',
    table: sn.incidentTable,
    record: toIncidentFields(payload),
    correlationField: 'correlation_id',
    resolve: payload.status === 'resolved',
  };
}

/**
 * Send a built delivery to ServiceNow.
 * @param {import('./servicenow/client.js').ServiceNowClient} client
 * @param {ReturnType<typeof buildDelivery>} delivery
 * @param {string} correlationId
 */
export async function deliver(client, delivery, correlationId) {
  if (delivery.target === 'import_set') {
    return client.importRow(delivery.table, delivery.record, correlationId);
  }
  return client.upsertByCorrelation(delivery.table, delivery.correlationField ?? 'correlation_id', delivery.record, {
    correlationId,
    resolve: delivery.resolve,
  });
}
