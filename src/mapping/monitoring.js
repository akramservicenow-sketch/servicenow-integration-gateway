/**
 * Monitoring alert -> ServiceNow incident mapping.
 *
 * Two target shapes are produced from the same alert:
 *  - `toImportSetRow`: columns of the staging table `u_monitoring_event_import`.
 *    The transform map (see servicenow/transform_map_onBefore.js) coalesces on
 *    u_correlation_id and decides insert / update / resolve on the instance.
 *  - `toIncidentFields`: direct Table API fields, used when SN_WRITE_MODE=table.
 * @module mapping/monitoring
 */

/**
 * Impact/urgency pairs chosen so the default priority lookup gives
 * critical=P1, major=P2, minor=P3, warning=P4, info=P5.
 */
export const SEVERITY_MATRIX = {
  critical: { impact: '1', urgency: '1' },
  major: { impact: '1', urgency: '2' },
  minor: { impact: '2', urgency: '2' },
  warning: { impact: '2', urgency: '3' },
  info: { impact: '3', urgency: '3' },
};

/** Stable key that ties every alert for the same host+check to one incident. */
export function correlationKey(alert) {
  return `${alert.source}:${alert.host}:${alert.check}`.toLowerCase().slice(0, 100);
}

function describe(alert) {
  const lines = [
    alert.description ?? '',
    '',
    `Source: ${alert.source}`,
    `Host: ${alert.host}`,
    `Check: ${alert.check}`,
    `Severity: ${alert.severity}`,
    `Occurred at: ${alert.occurred_at}`,
    `Event id: ${alert.event_id}`,
  ];
  if (alert.tags && Object.keys(alert.tags).length) {
    lines.push(`Tags: ${Object.entries(alert.tags).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  return lines.join('\n').trim();
}

/** @param {any} alert validated monitoring alert */
export function toImportSetRow(alert) {
  const { impact, urgency } = SEVERITY_MATRIX[alert.severity];
  return {
    u_correlation_id: correlationKey(alert),
    u_event_id: alert.event_id,
    u_source: alert.source,
    u_cmdb_ci: alert.host, // resolved to a CI by name in the transform map
    u_short_description: `[${alert.severity.toUpperCase()}] ${alert.host}: ${alert.summary}`.slice(0, 160),
    u_description: describe(alert),
    u_impact: impact,
    u_urgency: urgency,
    u_assignment_group: alert.assignment_group ?? '',
    u_state_action: alert.status === 'resolved' ? 'resolve' : 'open',
    u_occurred_at: alert.occurred_at,
  };
}

/** @param {any} alert */
export function toIncidentFields(alert) {
  const row = toImportSetRow(alert);
  return {
    correlation_id: row.u_correlation_id,
    correlation_display: 'sn-gateway',
    short_description: row.u_short_description,
    description: row.u_description,
    impact: row.u_impact,
    urgency: row.u_urgency,
    category: 'software',
    contact_type: 'monitoring',
    ...(alert.assignment_group ? { assignment_group: alert.assignment_group } : {}),
  };
}
