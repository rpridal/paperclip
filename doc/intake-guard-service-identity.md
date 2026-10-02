# Intake guard service identity (draft, not activated)

This fork adds a distinct `pcif_` bearer lane before ambient board, agent and webhook authentication. It does not add an agent, board key or heartbeat JWT. The lane is disabled without valid operator configuration. Do not provision or release this draft without separate human approval.

## Exact draft contract

Company is fixed to `b954377a-979e-461a-b568-44f9104f0512`. Stable service ID is `mista-intake-stall`.

GET `/api/companies/b954377a-979e-461a-b568-44f9104f0512/intake-guard/findings` returns a complete array of this service's findings, including done/cancelled episodes. No query parameters. It does not expose general company issues.

POST to the same path accepts exactly `{type:"intake_stall",episodeId:<UUID>,reasons:["queue_growing_without_completion" and/or "producer_enabled_without_completion_gate"],observedAt:<UTC ISO datetime>,queued:<nonnegative integer>,lastCompletedAt:<UTC ISO datetime or null>,producerSuspended:<boolean>}`. `observedAt` must be within 15 minutes of server time. No title, description, assignment, parent, blockers, execution policy, status or comment fields are accepted. The server generates the title prefix and marker. It creates only an unassigned backlog/high finding. It does not invoke a wake or comment route.

GET `/api/intake-guard/findings/<issue UUID>` returns only an owned finding. A foreign UUID is denied. Returned fields are id, identifier, title, description, status, createdAt and null assignments. All general issues, comments, wakes, assignment and update routes are denied for this bearer.

The PostgreSQL draft serializes creates on the company row. It deduplicates episode UUID and open findings. Closed findings count against a rolling one-hour cap. A previous finding requires a durable readback event before another episode can be created. POST retries must retain episodeId. The client must GET the returned UUID and verify the description marker, status and null assignments before it advances sampler state. A failed GET/POST/readback must stop publication, not fall back to another credential or reset the cap. This requires a client adapter update; the old general issues payload is deliberately incompatible.

## Provisioning recipe (instructions only; no credential issued)

After a human approves the reviewed server artifact and its installation, the operator generates 32 random bytes through the approved secret-management system. The client bearer format is `pcif_` followed by 64 lowercase hexadecimal characters. Store the bearer only in the sampler's approved secret store. Never print it or pass it in command arguments.

The operator gives the server `PAPERCLIP_INTAKE_GUARD_IDENTITY`, a strict JSON object with id, companyId, keyHash (SHA-256 of the complete bearer), issuedAt, expiresAt, issuerUserId, credentialVersion. This configuration contains no bearer. Maximum lifetime is 30 days. issuerUserId is the approving operator; record issuance, version and approval reference in the operator change audit. Server audits request outcomes and created/readback UUIDs, not headers, body, token or hash.

Rotation changes keyHash, timestamps and credentialVersion while preserving the stable service ID and company. Update all server replicas together; partial rollout is forbidden. The old bearer then fails authentication. Revocation removes the server configuration on all replicas. Expired credentials fail automatically. Keep the client paused during rotation/revocation and confirm secret-safe negative/positive auth probes only after the separately approved rollout. No overlap credential or fallback actor exists.

## Evidence and remaining gates

Live GET `/api/health` identified source commit `3549b7821728c2fdbe8fafa2ca10ba3ebc8b3061`, version `2026.930.0+fork.cre804`. The branch is based on that exact commit. The shipped runtime has not been changed.

HTTP/auth tests exercise the real actor middleware with an OFFLINE stub store. They are not live enforcement proof. PostgreSQL cap/readback/concurrency, issuer membership, lifecycle audit and fresh/expires/rotation negative tests still require review and further verification. The draft uses existing issue/activity tables; no migration or production write has been run. Full build and repository-wide checks are not yet complete. Do not merge or install this checkpoint.
