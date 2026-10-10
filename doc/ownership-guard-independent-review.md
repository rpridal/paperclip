# Independent bounded ownership-guard review

Review target: https://github.com/paperclipai/paperclip/pull/15233
Exact head: b47daef8c04a136094486bde097445b56cbc56ec
Previous head: dbe395693384f574c5616967daaeed118f30c4b4
Measured UTC: 2026-10-05T19:10:54Z

Verdict: the targeted ownership fix works in the exercised mock call paths. No new implementation defect was observed in this one-line delta. This is not safety approval or merge permission. A local previous-revision replay did not complete; it is explicitly unverified.

## Source and environment

Own isolated pcworktree, pinned to the exact head. `git diff <previous> HEAD --stat` returned three files, 120 insertions and 2 deletions: one implementation guard, a 116-line recording test, and checkpoint documentation. The implementation changes only the human completion predicate from `dbOrTx !== db` to `!ownsTransaction` (issues.ts:11281). Ownership is captured at line 10648 before executor shadowing; owned commit/publication routing uses that captured value at 11322-11330. The native terminal guard already uses the same value at 11109.

Root/server node_modules were read-only symlinks to existing installed dependencies, including existing compiled workspace packages. No dependency installation or shared source edit occurred. The reviewed issue service and test were loaded from this review worktree. This is not a fully rebuilt package graph or CI-equivalent build.

All tests used server cwd and this command prefix:

`env -u PAPERCLIP_API_KEY -u DATABASE_URL -u FORGEJO_TOKEN TMPDIR=<reviewer-profile-scratch> /opt/homebrew/opt/node/bin/node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/issue-update-lifecycle-ownership.test.ts`

## Actual execution

1. Prefix plus `-t 'owned caller' --maxWorkers=1 --reporter=verbose`: exit 0, 3 passed / 4 skipped, duration 38.61s. Default owned publication, fenced owned no-queue completion, and owned explicit queue retention all passed. The fixture checks persist before callback return, publication after callback return, exactly one owned transaction, and fence before the first issue read.

2. Prefix plus `-t 'supplied' --maxWorkers=1 --reporter=verbose`: exit 1, 3 passed / 1 failed / 3 skipped, duration 44.88s. The first missing-queue control (fence=false) hit Vitest's 15000ms test timeout; the fenced guard and both supplied-queue controls passed. This is a test-budget failure, not the expected ownership assertion failure.

3. Narrowed, changed approach: prefix plus `-t 'supplied caller retains.*fence=false' --maxWorkers=1 --testTimeout=25000 --reporter=verbose`: exit 0, 1 passed / 6 skipped, duration 39.02s; test itself took 5993ms. The supplied unfenced missing-queue rejection is confirmed. Across these completed groups, every one of the seven test identities has a PASS result. There is no single full-file GREEN claim.

4. Previous-revision replay: reverted only the guard in the own worktree. `git hash-object src/services/issues.ts` and `git rev-parse <previous>:server/src/services/issues.ts` both returned `8db7f52a449632989ada3e4755e12965979364d4`, proving exact previous implementation bytes. Prefix plus `-t 'opt-in owned caller does not require' --maxWorkers=1 --reporter=verbose` hit the command's 60s limit, exit 124, without an assertion result. No independent RED is claimed. Earlier author/reviewer RED evidence is not substituted for this incomplete replay. After one test timeout and one command timeout, testing stopped conservatively.

The guard was restored. `git hash-object server/src/services/issues.ts` and `git rev-parse HEAD:server/src/services/issues.ts` both returned `3a49543cf446aa9250fdf08779875a36371123e7`; git status was clean before adding this report. Remote PR ref still matched the pinned head.

## Limits and next bounded slice

The supplied guard is reached after recorded issue writes. No publication/archive persistence is observed in missing-queue controls, but this does not establish rollback of those preceding writes. The fixture's commit marker is callback return, not a SQL commit. Unrelated terminal hooks and activity delivery are mocked. No database, embedded PG, server, adapter, merge, deployment or activation was run. The coordinator remains unwired.

Next validator slice: exercise real update with distinct root/executor and root-read sentinels. Cover user assignment (assertAssignableUser 7154-7166, update call 10837), factory-bound instanceSettings (6623), and every project/execution workspace branch (helpers 7172/7198, update calls 10874/10884/10895/10904). These call sites omit the executor and the helpers default to root; this is pre-existing incomplete participation, not introduced by the guard delta. Snapshot routing/options/patch inputs before suspension. Require no relevant effects while the fence is pending or rejected.

Next relation slice: exercise real update with empty and nonempty blocker replacement, company/self/cycle veto, previous summary, validation, delete and insert on executor. `syncBlockedByIssueIds` 7438-7458 takes endpoint locks only for nonempty input; 7460-7470 still deletes for empty input. Canonical update has already locked its row before relation synchronization. A complete participant manifest and common lock-order proof are still needed; source inspection alone is not concurrency evidence.
