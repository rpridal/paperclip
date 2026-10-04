# Owner digest human-wait queue: dark persistence slice

This is not an enabled routing repair. The service is not exported from the service registry and has no HTTP, MCP, scheduler, recovery or client caller. No production writer populates the authorization table. No permission grants are created. Fixtures seed bindings only in disposable PostgreSQL. Do not enable a producer before the remaining boundaries are implemented and reviewed.

## Implemented

Additive version-1 owner_digest persistence with immutable company/origin/inbox/scope/producer identity. Existing bindings authorize exact JSONB scope, never a title, description or client boolean. Changed scope cannot reuse an old binding. Scope hashing is only an index accelerator: lookup compares exact JSONB and fails closed on a collision. Concurrent enqueue is insert-on-conflict plus exact readback. Lifecycle transitions use compare-and-swap and reject terminal overwrites. Authorization is checked even on duplicate operations, including origin company containment. Each service operation now runs in a transaction and holds PostgreSQL SHARE row locks on the origin and exact binding through commit. Binding DELETE/UPDATE and origin edits therefore serialize with enqueue/lifecycle writes: revocation-first denies without a queue mutation; mutation-first completes before revocation, and subsequent duplicate retries deny. This is atomic binding-ledger revocation only, not atomic revocation of a principal's membership, grants or audience policy; those still require the authenticated adapter before activation.

These rows are not approvals or standing trust. An answered lifecycle status is not an answer payload, delivery receipt or authority to deploy/delete. The service currently accepts server-internal producer identifiers; exposing it to an agent would be unsafe until an authenticated adapter maps its identity and checks existing policy. The binding ledger must not become an independent grant API.

## Dark ASK carrier identity

Migration 0287 adds a nullable ask_issue_id without backfilling earlier rows. The internal bindAsk operation assigns one distinct carrier once, after exact ledger authorization, under origin/binding SHARE locks, queue UPDATE lock and carrier UPDATE lock. First binding requires a same-company, unassigned todo carrier without checkout/execution lease, an already-blocked origin, an existing carrier-blocks-origin edge (held SHARE through commit), and no existing interaction of any status. Pending and answered legacy interactions are neither moved nor modified. A unique index prevents sharing one carrier between queue items; a trigger prevents replacing or clearing an established binding. Concurrent duplicate binds serialize. Enqueue explicitly projects its input fields so an untyped caller cannot inject ask_issue_id or lifecycle state.

This is identity persistence, not a reviewed compatibility intake, prompt guard, authorizer or admission exemption. It makes no title-based decision. Repeat binding rechecks ledger authorization but is only an identity retry; it is not authority to present, deliver, or revive a stale carrier. Carrier/origin/edge changes after binding are not yet prevented by all ordinary writers. Recovery/wake/checkout and interaction writers do not yet consult this field. Do not activate any caller until those shared boundaries and the authenticated versioned owner-only scope/revision contract are complete. The earlier arbitrary JSONB scope remains dark internal data, not a validated audience declaration. A DIGEST carrier, pinned document revision and server-verified answer receipt remain separate work.

Generate retains five snapshots: adding 0287 prunes 0282_snapshot.json, with SQL/journal history preserved. The FK uses NO ACTION, not SET NULL: deleting a carrier cannot silently erase typed identity or turn it into orphan work. No production migration or rollout has been performed.

## Remaining integration / decisions

Before activation, bind the producer and answerScope to existing audience/authorization policy without adding a permission grant; agree the exact versioned owner-only scope contract with the source/client work. Define ASK carrier identity, digest interaction/revision identity and verified answer receipt. Keep delivery idempotency separate from a lifecycle flag. Decide explicit reviewed compatibility intake for manually queued legacy ASK; do not infer trust from titles or move answered/pending interactions.

Next implementation owned by this issue: shared intentional-wait admission for recovery, assignment/comment/manual wake and checkout, plus pre-write ordinary-interaction denial. Exclude only validated queued/presented items; retain ordinary orphan repair. Then authorized digest materialize/delivery and full PostgreSQL/HTTP positive controls (machine critical, issue_document revision, formal approval). Runtime-platform enqueue/client adaptation requires its own issue worktree and PR, not changes here. Source audience work is tracked separately and must not be duplicated or bypassed by changing scope.

## Rollback and rollout

No feature activation is provided in this slice. Activation requires a separate default-off producer gate and guards that continue protecting persisted rows when that gate is off. Pause the producer before downgrading consumers. Preserve queue rows, answers and origin edges; never reinterpret a persisted typed wait as an orphan during downgrade. This migration contains no data backfill, title classification or changes to legacy interaction rows. A reviewed pinned-image rollout and any restart/install remain separate human approval steps.

## Validation scope

The focused PostgreSQL suite exercises persistence, enqueue retry races, lifecycle race rejection, routing immutability, exact-scope authorization, origin company containment and terminal handling. Lifecycle race tests hold the winning service transition in an uncommitted real transaction, observe the stale session's UPDATE blocked on that backend through pg_blocking_pids, then release the commit barrier. Both cancellation-first and presentation-first are tested; cancellation after a lost CAS must retry against the presented state. Promise start order and pg_sleep do not determine the winner. Removing the status CAS predicate makes both controlled-race tests fail, rather than silently accepting a terminal overwrite.

Migration generation intentionally prunes 0281_snapshot.json when adding 0286_snapshot.json: the established policy in DATABASE.md, Migration snapshots, retains only the newest five full snapshots. Historical snapshots remain in git history; no historical SQL migration or journal entry is deleted. This is generator policy, not a new queue cleanup or rollback action.

The suite does not claim digest delivery, direct ASK prompt rejection, recovery/wake protection or production acceptance. Full repository gates are not asserted by this slice.
