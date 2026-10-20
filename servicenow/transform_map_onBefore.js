/*
 * Transform Map: "Monitoring Event to Incident"
 *   Source table : u_monitoring_event_import  (extends sys_import_set_row)
 *   Target table : incident
 *   Script type  : onBefore  (runs for each staging row before field maps are applied)
 *
 * Companion field maps (configured on the transform map, not in this file):
 *   u_correlation_id    -> correlation_id
 *   u_short_description -> short_description
 *   u_description       -> description
 *   u_impact            -> impact
 *   u_urgency           -> urgency
 *   u_cmdb_ci           -> cmdb_ci            (reference, "Referenced value field name" = name,
 *                                              choice action = ignore so unknown hosts do not create CIs)
 *   u_assignment_group  -> assignment_group   (reference by name, choice action = ignore)
 *   [script]            -> sys_id  COALESCE   (see transform_map_coalesce_sys_id.js; matches
 *                                              only ACTIVE incidents for the correlation id)
 *
 * Written for this portfolio project against synthetic data. Variables provided
 * by the platform: source, target, map, log, action, ignore, error, error_message.
 */
(function runTransformScript(source, map, log, target) {
    var REQUIRED = ['u_correlation_id', 'u_short_description', 'u_impact', 'u_urgency', 'u_state_action'];
    var VALID_LEVELS = { '1': true, '2': true, '3': true };

    // 1. Reject rows that the gateway should never have sent.
    for (var i = 0; i < REQUIRED.length; i++) {
        if (!source.getValue(REQUIRED[i])) {
            error = true;
            error_message = 'Missing required field ' + REQUIRED[i];
            log.error('[monitoring-import] ' + error_message + ' (row ' + source.getUniqueValue() + ')');
            return;
        }
    }
    if (!VALID_LEVELS[source.getValue('u_impact')] || !VALID_LEVELS[source.getValue('u_urgency')]) {
        error = true;
        error_message = 'Impact/urgency must be 1, 2 or 3';
        return;
    }

    var stateAction = source.getValue('u_state_action');

    // 2. A recovery with no open incident is noise: skip it rather than create
    //    an incident only to close it straight away.
    if (action == 'insert' && stateAction == 'resolve') {
        ignore = true;
        log.info('[monitoring-import] resolve ignored, no active incident for ' + source.getValue('u_correlation_id'));
        return;
    }

    // 3. Host names arrive as FQDNs; CIs are usually named by short host name.
    var host = source.getValue('u_cmdb_ci');
    if (host && host.indexOf('.') > 0 && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        source.setValue('u_cmdb_ci', host.split('.')[0]);
    }

    if (action == 'update') {
        // 4. Never de-escalate an open incident because a later alert is milder.
        //    Field maps copy from source, so adjust the source values.
        if (parseInt(source.getValue('u_impact'), 10) > parseInt(target.getValue('impact'), 10)) {
            source.setValue('u_impact', target.getValue('impact'));
        }
        if (parseInt(source.getValue('u_urgency'), 10) > parseInt(target.getValue('urgency'), 10)) {
            source.setValue('u_urgency', target.getValue('urgency'));
        }
        // Keep the original short description so the record does not churn.
        source.setValue('u_short_description', target.getValue('short_description'));

        if (stateAction == 'resolve') {
            target.setValue('state', 6); // Resolved
            target.setValue('close_code', 'Solution provided');
            target.setValue('close_notes', 'Auto-resolved: monitoring reported recovery at ' + source.getValue('u_occurred_at'));
        } else {
            target.work_notes = 'Repeat alert from ' + source.getValue('u_source') +
                ' (event ' + source.getValue('u_event_id') + ') at ' + source.getValue('u_occurred_at');
        }
    } else {
        // New incident: stamp channel and caller defaults.
        target.setValue('contact_type', 'monitoring');
        target.setValue('caller_id', gs.getProperty('x_portfolio.monitoring.caller_sys_id', ''));
    }
})(source, map, log, target);
