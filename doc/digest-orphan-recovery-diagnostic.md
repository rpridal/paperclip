# Digest queue versus orphan recovery: diagnostic, not a fix

## Executable evidence

Run from the repository root with a pinned copy of the external owner-digest client:

    python3 scripts/smoke/digest-orphan-recovery.py --digest-script /path/to/owner-digest.py
    python3 scripts/smoke/digest-orphan-recovery.py --digest-script /path/to/owner-digest.py --characterize

Measured client SHA256: b12cdb8bbc684f04e410feca978ef32501e9bafdce79fc24900e9965823fc7f5.
Source baseline: d3e0f0a238ed66a05d50ab6f627eb55874f0f57e.
The client is maintained in the separate runtime-platform repository (scripts/owner-digest.py), not vendored here.

The default command deliberately exits 1: `queued high ASK must not be assigned by orphan repair`, actual 1, expected 0. This is a regression acceptance contract, NOT a passing repair test.
`--characterize` exits 0: enqueueUrgent=false, orphanAssigned=1, issue_assigned wake with mutation=unassigned_blocker_recovery, originStatus=blocked, queueBeforeCheckout=1, queueAfterSimulatedCheckout=0. Ordinary orphan and non-invokable-creator controls pass.

The fixture runs the actual client enqueue/collect_queue and the actual reconcileUnassignedBlockingIssues source body, removing only two TypeScript annotations. In-memory Drizzle/dependency seams replace database and wake dispatch. Source selection is evaluated, not replaced with a hardcoded candidate result. No live database, adapter, credentials, or HTTP calls are used. Python HTTP transport is denied; Node VM has only injected offline dependencies. It does not execute the full heartbeat orchestration, PostgreSQL SQL, or an LLM agent. The downstream checkout is an explicitly labelled status projection, not a real adapter execution. The repair produces no interaction itself; subsequent agent prompt behavior is established by the observed live audit, not fabricated in the fixture.

## Source -> repair -> wake -> prompt

External enqueue creates an unassigned `todo`, high-priority child under DIGEST-INBOX. Queue identity is only a title/description convention; observed originKind=manual and originId=null. Enqueue's high priority is not urgent and produces no prompt.

server/src/services/recovery/service.ts:2112-2236 selects unassigned todo/blocked issues with a blocks relation to nonterminal work and a creator agent. It checks neither queue identity nor urgency. It assigns the creator, adds Assigned Orphan Blocker, logs source=recovery.reconcile_unassigned_blocking_issue and enqueues issue_assigned with mutation=unassigned_blocker_recovery, context source=issue.unassigned_blocker_recovery.

Live audit independently shows issue.created at 06:19:10Z, assignmentWakeSkipped=true/no_agent_assignee; recovery issue.updated at 06:19:50Z; an automation run created at 06:19:50Z and started at 06:23:24Z on the ASK; issue.thread_interaction_created at 06:24:42Z in that run, kind=ask_user_questions, human_only, addresseeUserId=null. The board subsequently answered and the ASK was closed. None of these events prove daily-digest delivery.

Repair itself does not change status or create a prompt. Assignment admits an agent execution, whose checkout changes status to in_progress. The real client reader only considers todo ASK rows for the next materialize; consequently a checked-out ASK disappears from the queue even before an answer. The fixture confirms this reader consequence independently of the live trace.

## Ranked hypotheses and verdict

1. Generic orphan recovery treats a queued ASK as executable work: confirmed by source execution and exact live recovery source/run association.
2. Enqueue considers high urgency and opens a direct prompt: falsified; actual enqueue reports urgent=false and only creates one issue in the offline transport.
3. Daily materialize created the observed prompt: unsupported and inconsistent with the recorded interaction being on the ASK after orphan assignment rather than a digest window.

Platform fault: there is no typed intentional human-wait queue contract at repair/wake boundaries; the generic repair is correct for ordinary orphan work but incorrect for this queue convention. Agent fault: the woken agent created a direct, unaddressed human prompt on a queued high ASK, bypassing the intended daily route. Removing the repair alone is not a complete prompt authorization guard against other wake paths.

No production fix is included. A title prefix, free-text urgency, or description-only skip could accidentally exempt ordinary blockers or be spoofed. A bounded, safe server-only exception is not evident because the enqueue client currently carries no authoritative queue discriminator. Native type plus client adoption plus dispatch/interaction guards require a separate implementation slice.

## Proposed machine-readable boundary (not deployed)

Persist a validated, first-class humanWaitQueue discriminator with version, queueKind=owner_digest, originIssueId, inboxIssueId, answerScope and lifecycle=queued|presented|answered|cancelled. Bind origin/inbox to the same company, validate the block relation, and restrict lifecycle mutation to the authorized enqueue/materialize/answer paths. Do not grant an exemption based on the ASK title, parent name, description, arbitrary client flags or textual urgency. Existing manual cards must not silently acquire this exemption; adopt only a narrowly reviewed compatibility plan for genuinely unassigned/unanswered queue rows. Do not rewrite already answered ASK rows or pending interactions.

Recovery must exclude only a validated intentional humanWaitQueue (queued/presented) before assignment. Ordinary todo/blocked orphan cards retain the current creator repair. Shared wake/checkout admission must also reject queue rows as executable agent work, so comment/assignment/manual wake paths cannot undo the repair exclusion. Such rejection must preserve the ASK state and the origin's blocks relation, with an auditable reason instead of closing or auto-answering anything.

At the agent-facing interaction mutation boundary, an ASK queue row is not an authorized place for a direct ordinary human prompt. Refuse that operation even if a stray agent wake is delivered. The authorized materializer presents a single digest interaction in its daily window; origin remains blocked, ASK remains visible to the next materialize, and answer delivery alone completes the ASK and resumes origin. An agent wake must never be treated as human approval.

Retain machine-critical urgency as the existing immediate route on the origin (not permission to prompt directly on ASK). Preserve issue_document + concrete revisionId review routing and formal approval authorization unchanged; queue metadata and an answer never expand platform grants. Test these as independent positive controls in the implementation slice, not by bypassing guards with a caller-provided boolean.

Acceptance for that slice: turn the default regression GREEN; real PostgreSQL lifecycle and shared admission tests for every wake source; direct high ASK prompt rejected without a new interaction; origin still blocked; next offline materialize selects ASK; ordinary orphan repaired; critical/doc-revision/formal approval positive controls unchanged. This diagnostic does not claim these proposed guards are implemented or that those positive controls were exercised.

Any production rollout is a separate human approval gate after reviewed code, green tests, a pinned image and a rollback plan. This PR is fixture/documentation only and authorizes no deployment, restart, data deletion or live synthetic prompt.
