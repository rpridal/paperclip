# Intake guard service identity (draft, not activated)

This fork adds a distinct `pcif_` bearer lane before ambient board, agent and webhook authentication. It does not add an agent, board key or heartbeat JWT. The lane is disabled without valid operator configuration. Do not provision or release this draft without separate human approval.

## Exact draft contract

Company is fixed to `b954377a-979e-461a-b568-44f9104f0512`. Stable service ID is `mista-intake-stall`.

GET `/api/companies/b954377a-979e-461a-b568-44f9104f0512/intake-guard/findings` returns a complete array of this service's findings, including done/cancelled episodes. No query parameters. It does not expose general company issues.

POST to the same path accepts exactly `{type:"intake_stall",episodeId:<UUID>,reasons:["queue_growing_without_completion" and/or "producer_enabled_without_completion_gate"],observedAt:<UTC ISO datetime>,queued:<nonnegative integer>,lastCompletedAt:<UTC ISO datetime or null>,producerSuspended:<boolean>}`. `observedAt` must be within 15 minutes of server time. No title, description, assignment, parent, blockers, execution policy, status or comment fields are accepted. The server generates the title prefix and marker. It creates only an unassigned backlog/high finding. It does not invoke a wake or comment route.

GET `/api/intake-guard/findings/<issue UUID>` returns only an owned finding. A foreign UUID is denied. Returned fields are id, identifier, title, description, status, createdAt and null assignments. All general issues, comments, wakes, assignment and update routes are denied for this bearer.

The PostgreSQL draft serializes creates on the company row. It deduplicates episode UUID and open findings. Closed findings count against a rolling one-hour cap. A previous finding requires a durable readback event before another episode can be created. POST retries must retain episodeId. The client must GET the returned UUID and verify the description marker, status and null assignments before it advances sampler state. A failed GET/POST/readback must stop publication, not fall back to another credential or reset the cap. This requires a client adapter update; the old general issues payload is deliberately incompatible.

## Client adapter change (required, not installed)

Measured client source: Mista PR #201 at `ed927d8db7624953a488ab14c5468855730350d7`. `scripts/intake_guard_service.py` lines 26–30 allow only the old issues routes. `scripts/intake_guard_readers.py` delegates publication to `intake_stall_guard.publish`. That function lines 50–71 posts a free-form title/description/status payload and requires exact description equality. It cannot consume this endpoint unchanged. Infra must update these three call sites; do not widen the server scope to accept the old payload.

The new adapter must use the exact list path above, without query strings or a limit; reject a non-array or truncated/oversized response. Preserve the local one-hour cap and single-writer lock. Before publishing, GET and verify the last owned episode UUID, including a closed episode, so a restart cannot skip durable readback. GET list alone is not a readback receipt. Stop on every failed or mismatched receipt. Persist a fresh UUID as episodeId before POST; retries must keep it. Map reasons unchanged; map sample.observed_at to observedAt, sample.counts.queued to queued, sample.last_completed_at to lastCompletedAt, and the suspended argument to producerSuspended. Normalize timestamps to UTC Z. Set type to intake_stall; omit all old issue fields.

After POST, GET the returned id on the dedicated readback path. Compare the response id, identifier, status and assignments with the POST response, require the marker and parse the JSON line after it. For a fresh episode, compare the parsed structured fields with the submitted payload. For an existing open episode returned by server dedupe, accept only a valid owned intake_stall structure; do not assert that it is the new episode. Return deduplicated for that case. Never mark sampler publication successful before verified readback. A 400/401/403/503, network error, cap or readback refusal is terminal for that tick; do not fall back to agent/board credentials. The client remains paused until the integration owner tests and separately approves its installation.

## Provisioning recipe (instructions only; no credential issued)

After a human approves the reviewed server artifact and its installation, the operator generates 32 random bytes through the approved secret-management system. The client bearer format is `pcif_` followed by 64 lowercase hexadecimal characters. Store the bearer only in the sampler's approved secret store. Never print it or pass it in command arguments.

The operator gives the server `PAPERCLIP_INTAKE_GUARD_IDENTITY`, a strict JSON object with id, companyId, keyHash (SHA-256 of the complete bearer), issuedAt, expiresAt, issuerUserId, credentialVersion. This configuration contains no bearer. Maximum lifetime is 30 days. issuerUserId is the approving operator; record issuance, version and approval reference in the operator change audit. Server audits request outcomes and created/readback UUIDs, not headers, body, token or hash.

Rotation changes keyHash, timestamps and credentialVersion while preserving the stable service ID and company. Update all server replicas together; partial rollout is forbidden. The old bearer then fails authentication. Revocation removes the server configuration on all replicas. Expired credentials fail automatically. Keep the client paused during rotation/revocation and confirm secret-safe negative/positive auth probes only after the separately approved rollout. No overlap credential or fallback actor exists.

## Evidence and remaining gates

Live GET `/api/health` identified source commit `3549b7821728c2fdbe8fafa2ca10ba3ebc8b3061`, version `2026.930.0+fork.cre804`. The branch is based on that exact commit. The shipped runtime has not been changed.

HTTP/auth tests exercise the real actor middleware with an OFFLINE stub store. They are not live enforcement proof. Disposable real-PostgreSQL tests exercise concurrent replicas (eight creates yield one finding), closed-episode list/dedupe, rolling hourly cap, durable readback, rotation ownership, foreign origins/companies, issuer membership and safe audit fields. HTTP negative tests cover expiry, future issuance, overlong lifetime, revocation, rotation, foreign company/type and strict payload. Each request requires an active company and active user issuer membership with role owner/admin/operator/member; viewer and inactive/missing membership fail closed. Issuance/rotation/revocation remain operator changes with an external approval audit, not a service API. The draft uses existing issue/activity tables; no migration or production write has been run. Full build and repository-wide checks are not complete. Client adapter compatibility and SHA-pinned independent review remain required. Do not merge or install this checkpoint.
