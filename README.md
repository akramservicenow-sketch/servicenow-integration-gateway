# servicenow-integration-gateway

[![CI](https://github.com/akramservicenow-sketch/servicenow-integration-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/akramservicenow-sketch/servicenow-integration-gateway/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-20%20%7C%2022-green)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A Node.js 20 / Express service that shows a common enterprise integration pattern: an external
system (a monitoring tool or an HR system of record) posts events to a webhook, and the gateway
turns them into ServiceNow records safely and reliably.

**Verify, validate, dedupe, map, deliver, and do not lose anything:**
HMAC signatures with replay protection, JSON Schema validation, idempotency keys, mapping to
Incident (through the **Import Set API + transform map**) or HR case records (through the
**Table API**), retries with exponential backoff, a circuit breaker, a dead-letter queue with
replay, structured JSON logs with correlation ids, and health/readiness endpoints.

> **Note:** This is an independent, representative portfolio project built with synthetic data; not code from any employer or client.
> Hosts, employee numbers and groups in the examples are made up.

---

## Use case

* **Monitoring to Incident.** Alerts from a monitoring tool should open one incident per
  host+check, update it when the alert repeats or escalates, and resolve it on recovery,
  without flooding the instance during an alert storm.
* **HR lifecycle to HR case.** An HR system of record emits onboarding, offboarding and
  job-change events. Each should create an HR case, and **no personal data beyond an opaque
  employee number** should pass through the integration.

The repo also includes instance-side artifacts written by hand (see [`servicenow/`](servicenow/)):
the transform map scripts the Import Set path relies on, a Scripted REST API that does the same
job on-platform, and notes on building it with Flow Designer, IntegrationHub and a MID Server.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant SRC as Event source<br/>(monitoring / HR)
    participant GW as Integration gateway
    participant IDS as Idempotency store
    participant CB as Circuit breaker + retry
    participant SN as ServiceNow
    participant DLQ as Dead-letter queue

    SRC->>GW: POST /webhooks/monitoring<br/>X-Signature-256, X-Signature-Timestamp
    GW->>GW: correlation id, HMAC + timestamp check
    alt bad signature
        GW-->>SRC: 401 invalid_signature
    end
    GW->>GW: JSON Schema validation
    alt invalid payload
        GW-->>SRC: 400 validation_failed (field details)
    end
    GW->>IDS: claim(route:event_id | Idempotency-Key)
    alt already processed
        IDS-->>GW: stored result
        GW-->>SRC: 200 duplicate=true
    end
    GW->>GW: map payload (severity to impact/urgency, PII minimisation)
    GW->>CB: deliver
    CB->>SN: POST /oauth_token.do (client credentials, cached)
    CB->>SN: POST /api/now/import/u_monitoring_event_import
    Note over SN: transform map onBefore + sys_id coalesce<br/>insert / update / resolve incident
    alt 2xx
        SN-->>CB: import set result (inserted / updated / ignored)
        CB-->>GW: INC number, sys_id
        GW->>IDS: complete(result)
        GW-->>SRC: 201 / 200 delivered
    else 429 / 5xx / timeout, retries exhausted, or circuit open
        CB-->>GW: error
        GW->>DLQ: add(mapped record, reason, correlation id)
        GW-->>SRC: 202 queued (sender does not need to retry)
        Note over DLQ,SN: operator: GET /admin/dlq, POST /admin/dlq/:id/replay
    end
```

### Project layout

```
src/
  app.js                 Express app factory (routes, DI for tests)
  server.js              entry point, graceful shutdown
  config.js              env-only config with validation and redacted summary
  processor.js           build + deliver (shared by webhooks and DLQ replay)
  lib/
    hmac.js              sign / verify (timestamped, constant-time compare)
    validator.js         Ajv JSON Schema validation
    idempotency.js       TTL store with in-flight protection
    retry.js             exponential backoff with jitter, Retry-After support
    circuitBreaker.js    closed / open / half_open
    dlq.js               memory or file (JSONL) dead-letter queue
    logger.js            JSON logger with child bindings and redaction
  mapping/               monitoring to incident or import row, HR event to HR case
  middleware/            correlation id, signature, admin auth, error handler
  servicenow/client.js   Table API + Import Set API client (OAuth / basic)
  schemas/               monitoring-alert and hr-event JSON Schemas
mock-servicenow/         Express mock: OAuth, Table API, Import Set API, fault injection
servicenow/              instance-side scripts and IntegrationHub design notes
examples/                sample payloads
scripts/sign-payload.js  sign a payload for curl
test/                    node:test + supertest (41 tests)
```

## Setup

Requirements: Node.js 20 or newer (Docker optional).

```bash
git clone https://github.com/akramservicenow-sketch/servicenow-integration-gateway.git
cd servicenow-integration-gateway
npm ci
npm run lint
npm test            # 41 tests; the mock ServiceNow runs on 127.0.0.1, no external network
```

### Run locally with the mock

```bash
# terminal 1
npm run start:mock                       # mock ServiceNow on :4000

# terminal 2
export WEBHOOK_SECRET=local-dev-only-webhook-key-change-me-0001
SN_INSTANCE_URL=http://127.0.0.1:4000 SN_ALLOW_HTTP=true \
SN_CLIENT_ID=mock-client-id SN_CLIENT_SECRET=mock-client-secret \
ADMIN_TOKEN=local-dev-admin-token npm start
```

### Or with Docker Compose

```bash
docker compose up --build                # gateway on :3000, mock on :4000
```

The compose file uses obviously local-only values for the mock. For a real instance, copy
`.env.example` to `.env`, fill it from your secret store, and do not set `SN_ALLOW_HTTP`.

## Try it with curl

`scripts/sign-payload.js` prints the two signature headers and the compact body to send:

```bash
export WEBHOOK_SECRET=local-dev-only-webhook-key-change-me-0001
send() {
  OUT=$(node scripts/sign-payload.js "$1")
  curl -s -i -X POST "http://localhost:3000$2" -H 'Content-Type: application/json' \
    -H "$(echo "$OUT" | sed -n 1p)" -H "$(echo "$OUT" | sed -n 2p)" \
    -H 'X-Correlation-ID: demo-corr-0001' -d "$(echo "$OUT" | sed -n 3p)"
}
```

**1. A new alert creates an incident through the Import Set API**

```bash
send examples/monitoring-alert.json /webhooks/monitoring
```
```
HTTP/1.1 201 Created
X-Correlation-ID: demo-corr-0001

{"status":"delivered","action":"inserted","table":"incident","sys_id":"2ea15d6e30bb09d858392785e17fcde2",
 "number":"INC0010001","import_set":"ISET0010001","correlationId":"demo-corr-0001"}
```

**2. The sender retries the same event, and the stored result comes back**

```
HTTP/1.1 200 OK

{"status":"delivered","action":"inserted","table":"incident","number":"INC0010001",...,"duplicate":true}
```

**3. Recovery resolves the same incident (coalesced on the correlation id)**

```bash
send examples/monitoring-alert-resolved.json /webhooks/monitoring
```
```
HTTP/1.1 200 OK

{"status":"delivered","action":"updated","table":"incident","sys_id":"2ea15d6e30bb09d858392785e17fcde2",
 "number":"INC0010001","import_set":"ISET0010002","correlationId":"demo-corr-0001"}
```

**4. An HR onboarding event creates an HR case through the Table API**

```bash
send examples/hr-onboarding.json /webhooks/hr
```
```
HTTP/1.1 201 Created

{"status":"delivered","action":"inserted","table":"sn_hr_core_case","sys_id":"8bf28f1e6cc5c1e6c50c54d73b92b51e",
 "number":"HRC0010001","correlationId":"demo-corr-0001"}
```

**5. A bad signature is rejected**

```bash
curl -s -X POST localhost:3000/webhooks/monitoring -H 'Content-Type: application/json' \
  -H "X-Signature-Timestamp: $(date +%s)" -H 'X-Signature-256: sha256=deadbeef' \
  -d @examples/monitoring-alert.json
```
```
{"error":"invalid_signature","correlationId":"31a10843-48e0-43eb-89e8-02f1dce06d4d"}
```

**6. ServiceNow is down: retries, then DLQ, then replay**

```bash
curl -s -X POST localhost:4000/__mock/faults -H 'Content-Type: application/json' -d '{"failNext":20,"status":503}'
send examples/monitoring-alert.json /webhooks/monitoring     # (with a new event_id)
```
```
HTTP/1.1 202 Accepted

{"status":"queued","dlqId":"c302ed21-9554-47a9-b877-a770d82e6a80","reason":"HttpError","correlationId":"demo-corr-0001"}
```
```bash
curl -s localhost:3000/admin/dlq -H 'Authorization: Bearer local-dev-admin-token'
```
```
{"count":1,"entries":[{"id":"c302ed21-...","attempts":1,"route":"monitoring",
 "idempotencyKey":"monitoring:evt-20261019-0099","correlationId":"demo-corr-0001",
 "reason":"HttpError: ServiceNow POST /api/now/import/u_monitoring_event_import -> 503",
 "table":"u_monitoring_event_import","target":"import_set"}]}
```
```bash
curl -s -X POST localhost:3000/admin/dlq/c302ed21-.../replay -H 'Authorization: Bearer local-dev-admin-token'
```
```
{"status":"delivered","action":"inserted","table":"incident","number":"INC0010002","import_set":"ISET0010003"}
```

**Logs** are one JSON object per line, and every line for a request carries its correlation id:

```
{"ts":"...","level":"warn","msg":"retrying ServiceNow call","service":"sn-gateway","correlationId":"demo-corr-0001","attempt":1,"delayMs":50,"status":503,...}
{"ts":"...","level":"info","msg":"request completed","service":"sn-gateway","correlationId":"demo-corr-0001","method":"POST","path":"/webhooks/monitoring","status":201,"durationMs":103}
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/monitoring` | Monitoring alert to Incident (Import Set or Table API) |
| POST | `/webhooks/hr` | HR lifecycle event to HR case (Table API) |
| GET | `/health` | Liveness, circuit state and DLQ depth |
| GET | `/ready` | 503 while the circuit is open (lets a load balancer shed traffic) |
| GET | `/admin/dlq` | List DLQ entries (metadata only); requires `ADMIN_TOKEN` |
| POST | `/admin/dlq/:id/replay` | Re-deliver one entry |

| Status | Meaning |
|---|---|
| 201 / 200 | Delivered (inserted / updated or ignored) |
| 200 + `duplicate: true` | Already processed; original result returned |
| 202 `queued` | Not delivered; stored in the DLQ for replay |
| 400 | Schema violation, malformed JSON, or invalid `Idempotency-Key` |
| 401 | Missing or invalid signature, or timestamp outside tolerance |
| 409 | Same idempotency key is still being processed |
| 413 / 415 | Body too large / not `application/json` |

## Configuration

All configuration comes from environment variables (see [`.env.example`](.env.example)).

| Variable | Default | Notes |
|---|---|---|
| `WEBHOOK_SECRET` | required | At least 32 characters; shared with the event source |
| `SIGNATURE_TOLERANCE_SEC` | `300` | Replay window |
| `SN_INSTANCE_URL` | required | `https://` enforced unless `SN_ALLOW_HTTP=true` (mock only) |
| `SN_AUTH_MODE` | `oauth` | `oauth` (client credentials) or `basic` |
| `SN_WRITE_MODE` | `import_set` | `import_set` (staging + transform) or `table` (direct upsert) |
| `SN_IMPORT_TABLE` / `SN_INCIDENT_TABLE` / `SN_HR_CASE_TABLE` | see `.env.example` | Target tables |
| `RETRY_MAX`, `RETRY_BASE_MS`, `RETRY_MAX_MS` | `4`, `250`, `8000` | Backoff with jitter; `Retry-After` honoured |
| `CB_FAILURE_THRESHOLD`, `CB_RESET_MS` | `5`, `30000` | Circuit breaker |
| `IDEMPOTENCY_TTL_MS` | 24 h | How long processed keys are remembered |
| `DLQ_MODE`, `DLQ_FILE` | `memory` | `file` writes JSONL with mode 0600 |
| `ADMIN_TOKEN` | unset | Admin API is not mounted at all when unset |

### Why Import Set for incidents?

Writing to a staging table and letting a **transform map** do the insert/update keeps mapping
rules on the instance, where the platform team can see and govern them. Every row stays
traceable in the import set, and the same transform can serve file loads too. The onBefore
script ([`servicenow/transform_map_onBefore.js`](servicenow/transform_map_onBefore.js)) rejects
incomplete rows, ignores recoveries with no open incident, and never de-escalates an open
incident. The coalesce script ([`servicenow/transform_map_coalesce_sys_id.js`](servicenow/transform_map_coalesce_sys_id.js))
matches only **active** incidents, so a new outage does not re-open last week's ticket. The
mock server implements the same rules so the tests exercise them.

## Security considerations

* **OAuth client credentials.** Register an OAuth API endpoint for external clients
  (*System OAuth > Application Registry*) tied to a dedicated integration user. Tokens are
  cached and refreshed once on 401. Basic auth is supported for labs only.
* **Least-privilege integration user.** Mark it *Web service access only* (no interactive
  login). Grant only what each path needs: `import_transformer` (or a custom role with create
  on the staging table) for the Import Set path, a custom role with read/create/write on
  `incident` restricted by ACL for Table mode, and for HR cases a narrowly scoped HR
  integration role, never `admin` or `hr_admin`. Turn on *Run business rules* in the transform
  map so ACLs and data policies still apply.
* **Secret storage.** Secrets come from environment variables injected by a secret store
  (Vault, AWS Secrets Manager, Azure Key Vault, Kubernetes secrets). Nothing secret is in the
  image or the repo; `.env` is git-ignored and `.env.example` holds placeholders only. The
  logger redacts keys that look like secrets, and the startup summary is redacted.
* **HMAC verification.** The signature covers `timestamp.raw_body` with HMAC-SHA256 and is
  compared in constant time. Requests outside a 5-minute window are rejected (replay
  protection). Rotate the key by accepting two keys during a changeover (see roadmap).
* **PII minimisation.** The HR schema uses `additionalProperties: false`, so names, birth
  dates, personal emails or national ids are **rejected**, not silently dropped. The case
  carries only an opaque employee number and organisational codes; the instance resolves the
  person from its own HR profile. The DLQ stores the *mapped* record, never the raw body, and
  the DLQ listing returns metadata only.
* **Input hardening.** Body size limit (100 kb), strict content type, schema-bounded field
  lengths, validated `Idempotency-Key` and `X-Correlation-ID` formats, table names checked
  against a pattern, and encoded-query values stripped of `^`. Error responses never include
  stack traces or upstream bodies.
* **Transport.** Use HTTPS end to end. Terminate TLS in front of the gateway and, if your
  platform supports it, restrict inbound traffic to the event source's IP ranges.

## Limitations

* The idempotency store and circuit breaker live in process memory. With several replicas,
  move idempotency to a shared store (for example Redis `SET NX PX`) and accept per-replica
  breakers, or share breaker state.
* The file DLQ suits a single instance and is rewritten on every change. Use a durable queue
  (SQS, Service Bus, Kafka) in production.
* The mock ServiceNow implements only what the gateway calls. It is not a full Table API, and
  its transform logic mirrors the scripts in `servicenow/` rather than the platform engine.
* HMAC uses one shared key. There is no key rotation window or per-source key yet.
* HR case fields (`u_hr_service_name`, `u_subject_employee_number`) assume a small custom
  extension or a transform on the HR side. Real HR Service Delivery setups usually resolve
  `hr_service` and `subject_person` by sys_id.

## Roadmap

- [ ] Dual-key HMAC verification for zero-downtime key rotation
- [ ] Redis-backed idempotency store and DLQ adapter interface for SQS / Service Bus
- [ ] OpenTelemetry traces (propagate `traceparent` to ServiceNow)
- [ ] Batch Import Set inserts (`/api/now/import/{table}/insertMultiple`) for bursty sources
- [ ] Outbound leg: acknowledge alerts back to the monitoring tool when incidents resolve
- [ ] Contract tests against a personal developer instance (opt-in, never in CI)

## License

[MIT](LICENSE) © Shaik Akram
