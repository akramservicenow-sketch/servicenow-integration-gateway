/*
 * Field map source script on the "Monitoring Event to Incident" transform map.
 *   Target field : sys_id
 *   Coalesce     : true
 *
 * Coalescing directly on correlation_id would also match incidents that were
 * already resolved or closed, so a new outage would re-open last week's record.
 * Returning the sys_id of the ACTIVE incident (or -1 for "no match") limits the
 * coalesce to open work only.
 */
answer = (function transformEntry(source) {
    var correlationId = source.getValue('u_correlation_id');
    if (!correlationId) {
        return -1;
    }
    var inc = new GlideRecord('incident');
    inc.addActiveQuery();
    inc.addQuery('correlation_id', correlationId);
    inc.orderByDesc('sys_created_on');
    inc.setLimit(1);
    inc.query();
    return inc.next() ? inc.getUniqueValue() : -1;
})(source);
