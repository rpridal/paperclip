# Opt-in independent re-review

`executionPolicy.restartReviewOnChangesRequested: true` opts one change card into
re-review after a native participant requests changes. The default is unchanged.
This is a server capability proposal, not a live deployment claim.

The active participant uses the existing PATCH `status: in_progress` with a
nonempty decision comment. The recorded decision stays attributed to the
rejecting stage. The first review at or before that stage and all later gates
are invalidated in execution state; persisted decision history is not erased.
Stage IDs, roles, return assignee, policy, and monitor accounting stay intact.
Only the return assignee may resubmit `in_review` (or `done`, which starts the
workflow rather than bypassing review). Independent review then precedes delivery
and any verifier. A review rejection also restarts review. An approval-only chain
continues at its rejected approval because it has no earlier review.

Intermediate agent approvals do not reset the opt-in retry counter. At the cap,
the responsible human holds the first review, not stale delivery; agents cannot
advance that hold. Human decisions and terminal completion retain their existing
counter reset semantics. No new rights, board override, deployment, or mutation
of execution state via clients is introduced.

A moved PR head must still fail the Forgejo exact-head/stale/required-check gates.
Do not enable this flag on a live board until this revision is independently
reviewed and its rollout explicitly approved and verified. Old boards silently
strip unknown policy fields: merely PATCHing this flag is not evidence of support.
After deployment, verify reviewer -> delivery rejection -> executor resubmit ->
reviewer -> delivery -> verifier on the same card, including monitor bounds and
attempt count. Preserve the full existing policy when opting in; never replace it
with a partial generated payload. No application deployment is authorized here.

Verification:
`pnpm exec vitest run server/src/__tests__/issue-execution-review-restart.test.ts server/src/__tests__/issue-execution-policy.test.ts server/src/__tests__/issue-execution-policy-routes.test.ts`

Rollback before rollout: do not enable the flag. A live rollback needs explicit
state review; do not strip policy or regenerate stage IDs mid-flow.
