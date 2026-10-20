# Building the same integration with Flow Designer, IntegrationHub and a MID Server

The Node gateway in this repo runs **outside** the instance. This note covers how I would
build the same pattern **on the platform** with Flow Designer and IntegrationHub, when to pick
which, and how the MID Server fits in when one end of the integration is on-premises.

> Written for this independent portfolio project. It describes a design, not a specific
> customer implementation.

## 1. Which approach fits

| Concern | External gateway (this repo) | On-platform (Scripted REST + Flow / IntegrationHub) |
|---|---|---|
| Inbound volume spikes / alert storms | Buffers, dedupes and breaks the circuit before the instance sees the load | Every call consumes instance semaphores and transactions |
| Who holds ServiceNow credentials | Only the gateway; event sources hold an HMAC key | Each event source needs an instance account or OAuth client |
| Change control | Normal code pipeline (tests, PR review, container image) | Update sets / app repo; visible to ServiceNow admins |
| Visibility for platform team | Logs live outside the instance | Flow execution details, IntegrationHub usage dashboard |
| Licensing | No IntegrationHub transactions for inbound | Spoke steps count as IntegrationHub transactions |
| On-prem targets | Gateway must be deployed where it can reach them | MID Server handles reachability |

A common middle ground: keep the gateway for **inbound** events (volume, security boundary), and
use Flow Designer + IntegrationHub for **outbound** follow-up actions, especially to on-prem
systems through a MID Server.

## 2. Inbound, on-platform version

1. **Scripted REST API** (`scripted_rest_resource.js`) receives the webhook, checks the HMAC
   and the timestamp window, and validates required fields. Keep the resource thin.
2. Hand the work to a **subflow** so the HTTP call returns quickly and the logic is visible in
   Flow Designer:

   ```javascript
   // inside the Scripted REST resource, after validation
   sn_fd.FlowAPI.getRunner()
       .subflow('x_portfolio.process_monitoring_event')
       .inBackground()
       .withInputs({ correlation_id: correlationId, payload: JSON.stringify(body) })
       .run();
   response.setStatus(202);
   ```

3. **Subflow `process_monitoring_event`**
   - *Look Up Record* on `incident` where `correlation_id` = input and `active` = true
   - *If* found and status is `resolved`: *Update Record* (state Resolved, close code and notes)
   - *Else if* found: *Update Record* (escalate impact/urgency only, add a work note)
   - *Else if* status is `firing`: *Create Record* on `incident`
   - *Else*: end (a recovery with nothing open is ignored)
   - Use **flow error handling** (the error handler section) to log failures and create a task
     for the integration support group instead of failing silently.
4. For bulk or file-based feeds, write to the **Import Set** staging table instead and keep the
   transform map (`transform_map_onBefore.js`, `transform_map_coalesce_sys_id.js`) as the single
   place where mapping rules live.

## 3. Outbound to an on-prem system through a MID Server

Example: when the incident is resolved, acknowledge the alert in an on-prem monitoring tool,
or, for the HR case, provision an account in an on-prem directory service that has no
internet exposure.

### Build a small custom spoke

1. **Spoke scope**: `x_portfolio_onprem_monitor` (keeps actions, aliases and credentials together
   so the spoke can be versioned and promoted as one unit).
2. **Connection & Credential alias**: `x_portfolio_onprem_monitor.OnPremMonitor`
   - *HTTP Connection*: base URL of the on-prem API, for example `https://monitor.example.internal`
   - *Credential*: API key or basic auth credential record. Keep it on the credential record, never
     in flow inputs or scripts.
   - **Use MID Server**: on, with MID selection by *capability* or *application* (for example a
     `MonitorAPI` capability) so the flow does not hard-code a MID name. Use at least two MID
     Servers in the cluster for failover.
   - **Retry policy** on the connection: retry on 429/5xx and connection errors with exponential
     backoff. This is the platform equivalent of `src/lib/retry.js`.
3. **Action `Acknowledge Alert`**
   - Inputs: `alert_key` (string), `note` (string)
   - *REST step*: `POST /api/alerts/{alert_key}/ack` using the connection alias. The MID option
     comes from the alias.
   - *Script step*: parse the response, map non-2xx codes to an action error with a readable message
   - Outputs: `status`, `acknowledged_at`
4. **Flow** `Acknowledge monitoring alert on resolve`
   - Trigger: *Updated* on `incident` where `state` changes to Resolved and
     `contact_type` = monitoring
   - Action: *Acknowledge Alert* (alert key taken from `correlation_id`)
   - Error handler: add a work note and assign a follow-up task. Optionally write the failed
     request to a small custom "integration outbox" table and retry it from a scheduled flow
     (the DLQ pattern from this repo, on the platform).

### MID Server checklist

- MID Server service account: least privilege on the host; outbound HTTPS to the instance only.
- MID user on the instance: `mid_server` role only.
- Restrict the MID to the target subnets with IP ranges or capabilities; keep MIDs patched
  to match the instance family.
- Validate the MID before go-live (*MID Server > Validate*) and monitor it with MID Server
  issue notifications.
- Large payloads: tune the ECC queue and MID properties instead of raising flow timeouts.

## 4. Equivalents at a glance

| Gateway feature (this repo) | Platform equivalent |
|---|---|
| HMAC verification (`src/lib/hmac.js`) | Scripted REST resource with `GlideCertificateEncryption.generateMac` |
| JSON Schema validation | Validation in the Scripted REST resource, or subflow input checks |
| Idempotency store | Correlation-id lookup plus a unique index on a custom event table |
| Import Set write + transform map | Same: staging table, transform map, coalesce script |
| Retry + backoff | Connection alias retry policy (outbound) |
| Circuit breaker | No direct equivalent; approximate with an integration status property checked by the flow |
| Dead-letter queue | Custom outbox table and a scheduled retry flow, or a flow error handler that creates a task |
| Correlation ids | `X-Correlation-ID` stored on the record and shown in flow execution context |
| Structured logs | Flow execution details, `gs.info` with a consistent prefix, IntegrationHub usage dashboard |

## 5. Things that catch teams out

- **Transaction counting**: every spoke action run counts toward IntegrationHub usage. High-volume
  inbound events fanning out to spoke calls can use up an allocation quickly, which is one
  reason to filter and dedupe before events reach the instance.
- **Running as the right user**: flows triggered by an integration user run with that user's
  roles unless set to run as System. Decide on purpose, and document the choice.
- **Coalesce on active records only**: coalescing directly on `correlation_id` re-opens old
  incidents. Use the sys_id coalesce script.
- **Upgrade safety**: keep everything in a scoped app or spoke. Do not modify baseline spokes;
  copy the action into your own scope instead.
