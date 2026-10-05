# Addressed reviewer participation

This path repairs one coordination error. An addressed confirmation recipient
must not take the author's issue checkout to publish an independent host review.
The existing accept/reject routes remain the resolution path. There is no new
role, durable grant, database table, or migration.

## Existing request to host receipt

1. Use the reviewer's own run-bound agent credentials. Read the original issue
   and its interaction list. Select the exact pending `request_confirmation`
   addressed to that agent. Keep the stored creator, `not_creator` policy,
   addressee, source run, and continuation policy unchanged.
2. Record the issue status, assignee, checkout/execution run IDs, and execution
   stages before work. Do not checkout the issue, replace its assignee, clear a
   lease, restart review, or create a replacement confirmation.
3. Call `POST /api/issues/:issueId/interactions/:interactionId/participate` with
   `{}`, the agent bearer token, and `X-Paperclip-Run-Id`. A successful response
   names that interaction and run, `scope: "interaction"`, and the resolution
   actions `accept` and `reject`. This response is a current-state check, not
   permission to call a provider or mutate the task.
4. Use the supported host API to read the current PR head. Compare its complete
   SHA with the requested head. If the head differs or the request lacks exact
   head evidence, do not publish or accept. Reject with the stale/missing-head
   reason. The task owner must supply a current request through normal policy.
5. Use only the independently authorized reviewer identity on the host. Read any
   existing receipt first to avoid duplicate publication. Native APPROVE does
   not prove host APPROVED. An author's or administrator's credential is not a
   fallback for a missing reviewer permission.
6. Publish only the requested review for the exact head. Re-read the PR head and
   host receipt. Require the actual review ID, reviewer identity, exact commit
   SHA, and APPROVED state. A COMMENT receipt is not an approval. A changed head
   or failed read-back prevents acceptance.
7. Record the verified host evidence in an issue comment only if ordinary
   comment authorization permits it. Accept the original interaction with the
   existing `/accept` route. Use `/reject` for a failed verification. Include
   `X-Paperclip-Run-Id` on either request. Leave task lifecycle mutations alone.
8. Read the issue and resolved interaction again. Check resolver attribution and
   unchanged status, assignee, leases, and stages. Assignee wake continuation
   may still run; it does not itself transfer ownership or restart native stages.

If resolution fails after host publication, keep the receipt and denial evidence.
Do not publish again. Reconcile the pending interaction through the normal
authorized resolver path.

## Fail-closed conditions and limits

- The actor and run come from authentication, never the request body. Additional
  body fields are rejected. Board actors do not use this agent preflight.
- Company/read boundaries, low-trust and task-bridge containment, named audience,
  creator exclusion, company caps, and governed-action gates remain in force.
- The run must be running, unfinished, and bound to the issue. An interaction ID
  in its context must match. Closed issues and terminal interactions deny work.
- Current document revisions are checked under locks. Active owners or lease holders,
  duplicate reviewer runs, and runs on the same interaction cause `409` without
  clearing or stealing their leases. Denials are final for that attempt.
- Plan approvals, native completion reviews, and bound issue reviews keep their
  existing routes and lifecycle rules. The task owner keeps ordinary checkout.
- External PR heads and host receipts remain outside server enforcement. A SHA
  in prompt text or a custom target is not a server-verifiable host target. The
  agent's real host API checks are mandatory; this patch does not claim an
  atomic transaction across Paperclip and the host. Another run or host change
  can appear after preflight, so re-check before publication and resolution.
- Existing accept/reject calls for addressed non-owner confirmations also apply
  the live-run and conflict guards. This is an intentional tighter constraint,
  not a new general right to write issue status, assignment, or review stages.

## Compatible upgrade and rollback

The inspected deployed source is
`3549b7821728c2fdbe8fafa2ca10ba3ebc8b3061`. The implementation base is
`9417b9ee1470c3b6f5e3c901d12150fa84534988`. The deployed commit is a sibling,
not an ancestor of that base. Do not deploy the full branch as an unrelated
master upgrade. Apply only this patch to a release branch based on the deployed
source. The touched route, resolver, and schema entry points exist there; a
clean patch application is checked separately from runtime verification.

Before rollout, the release owner must:

1. Backport the patch to the deployed release branch and run the focused route,
   service, audience, shared-schema, and checkout regressions there. Compile the
   shared and server packages. Resolve release-wide checks separately; a clean
   patch application alone is not a production smoke test.
2. Package the server/shared changes with the updated Paperclip runtime skill
   and API reference. There is no database migration or historical data rewrite.
   Ensure new runs receive the updated skill; an already running agent may hold
   the old checkout-first instructions.
3. Wait for conflicting active work to finish. Do not kill runs or clear issue
   leases just to make participation pass. Snapshot the original pending request
   and issue invariants. Leave unrelated review-restart work unchanged.
4. Release through the normal operator-controlled deployment path. This work
   does not deploy, approve a host review, merge a PR, or mutate production.
5. Start an authorized issue-bound reviewer run for the existing request. Verify
   the exact-head host receipt and invariant read-back as described above. A
   `404` on preflight means the server does not support the route; stop rather
   than fall back to checkout.

For rollback, restore the previous server/shared bundle and runtime skill
together. No schema rollback is required. Stop new participant attempts before
rollback. Keep resolved attribution and any real host receipts intact. Reconcile
an already published receipt without duplicate publication or automatic native
review restart. Rolling back does not undo a host review.
