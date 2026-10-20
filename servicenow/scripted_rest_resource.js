/*
 * Scripted REST API resource (instance-side alternative to the gateway)
 *
 *   API        : Monitoring Events   (scope x_portfolio, API ID monitoring)
 *   Resource   : POST /api/x_portfolio/monitoring/v1/events
 *   Requires authentication : true   (OAuth or basic for the integration user)
 *   Requires ACL            : x_portfolio.monitoring_events_post (granted to the
 *                             integration role only)
 *
 * Use this when the event source can reach the instance directly and you want
 * the validation, idempotency and mapping to live on the platform. The Node
 * gateway in this repo does the same job outside the instance, which keeps
 * retries and buffering off the instance and works when the source cannot
 * hold ServiceNow credentials.
 *
 * Signature: the platform's GlideCertificateEncryption.generateMac returns a
 * base64 HMAC, so this resource expects  X-Signature-256: sha256=<base64>
 * computed over "<X-Signature-Timestamp>.<raw body>".
 *
 * Written for this portfolio project against synthetic data.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var MAX_SKEW_SEC = 300;
    var SEVERITY = {
        critical: { impact: '1', urgency: '1' },
        major: { impact: '1', urgency: '2' },
        minor: { impact: '2', urgency: '2' },
        warning: { impact: '2', urgency: '3' },
        info: { impact: '3', urgency: '3' }
    };

    function fail(status, code, detail) {
        response.setStatus(status);
        response.setBody({ error: code, detail: detail || '' });
    }

    // ---- 1. Signature and replay window --------------------------------------
    var ts = request.getHeader('x-signature-timestamp');
    var sig = request.getHeader('x-signature-256');
    var raw = request.body ? request.body.dataString : '';
    if (!ts || !sig || !raw) {
        return fail(401, 'invalid_signature', 'missing headers or body');
    }
    var nowSec = Math.floor(new GlideDateTime().getNumericValue() / 1000);
    if (Math.abs(nowSec - parseInt(ts, 10)) > MAX_SKEW_SEC) {
        return fail(401, 'invalid_signature', 'timestamp outside tolerance');
    }
    // Key stored base64-encoded in a system property readable only by admin
    // (or, preferably, in a Credentials record read via sn_cc.StandardCredentialsProvider).
    var keyB64 = gs.getProperty('x_portfolio.monitoring.webhook_key_b64');
    var expected = 'sha256=' + new GlideCertificateEncryption().generateMac(keyB64, 'HmacSHA256', ts + '.' + raw);
    if (!constantTimeEquals(expected, sig)) {
        return fail(401, 'invalid_signature', 'signature mismatch');
    }

    // ---- 2. Validate ----------------------------------------------------------
    var body = request.body.data;
    var required = ['event_id', 'source', 'host', 'check', 'severity', 'status', 'summary', 'occurred_at'];
    for (var i = 0; i < required.length; i++) {
        if (!body[required[i]]) {
            return fail(400, 'validation_failed', 'missing ' + required[i]);
        }
    }
    if (!SEVERITY[body.severity] || (body.status != 'firing' && body.status != 'resolved')) {
        return fail(400, 'validation_failed', 'invalid severity or status');
    }

    // ---- 3. Upsert by correlation id (natural idempotency) --------------------
    var correlationId = (body.source + ':' + body.host + ':' + body.check).toLowerCase().substring(0, 100);
    var inc = new GlideRecord('incident');
    inc.addActiveQuery();
    inc.addQuery('correlation_id', correlationId);
    inc.setLimit(1);
    inc.query();
    var exists = inc.next();

    if (body.status == 'resolved') {
        if (!exists) {
            response.setStatus(200);
            return response.setBody({ action: 'ignored', reason: 'no active incident' });
        }
        inc.setValue('state', 6);
        inc.setValue('close_code', 'Solution provided');
        inc.setValue('close_notes', 'Auto-resolved: monitoring reported recovery (event ' + body.event_id + ')');
        inc.update();
        response.setStatus(200);
        return response.setBody({ action: 'updated', number: inc.getValue('number'), sys_id: inc.getUniqueValue() });
    }

    var level = SEVERITY[body.severity];
    if (exists) {
        if (parseInt(level.impact, 10) < parseInt(inc.getValue('impact'), 10)) {
            inc.setValue('impact', level.impact);
        }
        if (parseInt(level.urgency, 10) < parseInt(inc.getValue('urgency'), 10)) {
            inc.setValue('urgency', level.urgency);
        }
        inc.work_notes = 'Repeat alert (event ' + body.event_id + ') at ' + body.occurred_at;
        inc.update();
        response.setStatus(200);
        return response.setBody({ action: 'updated', number: inc.getValue('number'), sys_id: inc.getUniqueValue() });
    }

    inc.initialize();
    inc.setValue('correlation_id', correlationId);
    inc.setValue('correlation_display', 'monitoring-api');
    inc.setValue('short_description', ('[' + body.severity.toUpperCase() + '] ' + body.host + ': ' + body.summary).substring(0, 160));
    inc.setValue('description', (body.description || '') + '\nEvent id: ' + body.event_id);
    inc.setValue('impact', level.impact);
    inc.setValue('urgency', level.urgency);
    inc.setValue('contact_type', 'monitoring');
    var ci = new GlideRecord('cmdb_ci');
    if (ci.get('name', String(body.host).split('.')[0])) {
        inc.setValue('cmdb_ci', ci.getUniqueValue());
    }
    var sysId = inc.insert();
    response.setStatus(201);
    response.setBody({ action: 'inserted', number: inc.getValue('number'), sys_id: sysId });

    function constantTimeEquals(a, b) {
        if (a.length != b.length) {
            return false;
        }
        var diff = 0;
        for (var j = 0; j < a.length; j++) {
            diff |= a.charCodeAt(j) ^ b.charCodeAt(j);
        }
        return diff === 0;
    }
})(request, response);
