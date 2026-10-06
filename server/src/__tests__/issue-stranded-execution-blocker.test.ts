/**
 * CRE-15: a settled automatic no-replay hold (`evidence.automaticRecovery.replay
 * === "blocked"`) used to park every later wake as `deferred_issue_execution`
 * with no run, so an issue that was plainly re-runnable never ran again and the
 * board had no action to resolve. These cases pin the fix:
 *
 *  T1  settled no-replay hold + `todo` issue + invokable agent owner → a run is
 *      created once and the hold is released (marked, never deleted)
 *  T2  an open (`active`) action still parks the wake
 *  T3  a human owner (`assigneeUserId`) still parks the wake — a person decides
 *  T4  an issue that is not `todo`/`blocked` still parks the wake
 *  T5  GET /issues/:id/recovery-actions surfaces the settled action referenced
 *      by `executionBlocker` (Patch A)
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stranded execution-blocker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue stranded by a settled no-replay hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-stranded-blocker-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentId?: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = agentId
        ? { type: "agent", agentId, runId: randomUUID(), companyId, source: "session" }
        : {
            type: "board",
            userId: "blocker-owner",
            source: "session",
            companyId,
            companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "operator" }],
            isInstanceAdmin: false,
          };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /** Issue with an execution-blocking recovery action on it. */
  async function seedBlockedIssue(opts: {
    issueStatus?: string;
    recoveryStatus?: "active" | "escalated" | "resolved";
    replay?: "blocked" | null;
    assigneeUserId?: string | null;
    includeAssignee?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stranded Co",
      issuePrefix: `S${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "blocker-owner",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "blocker-owner",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Infra",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // Cap concurrency at 1 and occupy the slot below: admission stays real
      // (a run is created) but no provider is ever launched by these cases.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `S-${issueId.slice(0, 4)}`,
      title: "Stranded issue",
      status: opts.issueStatus ?? "todo",
      assigneeAgentId: opts.includeAssignee === false ? null : agentId,
      assigneeUserId: opts.assigneeUserId ?? null,
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${sourceRunId}`,
      status: opts.recoveryStatus ?? "resolved",
      outcome: "blocked",
      nextAction: "Reconcile the stopped run before continuing.",
      evidence: {
        runId: sourceRunId,
        ...(opts.replay ? { automaticRecovery: { replay: opts.replay, actionOutcome: "blocked" } } : {}),
      },
    }).returning();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      processPid: process.pid,
    });
    return { companyId, issueId, agentId, sourceRunId, actionId: action!.id };
  }

  const wakeIssue = (agentId: string, issueId: string) =>
    heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "assignment",
    });

  const runsForIssue = async (issueId: string) =>
    db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.contextSnapshot?.issueId === issueId));

  const executionWaits = async (agentId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) =>
        rows.filter(
          (row) => row.payload?.executionWait !== undefined || row.reason === "execution_reconciliation_required",
        ),
      );

  it("T1: releases a settled no-replay hold once and starts a run instead of parking", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();

    const run = await wakeIssue(seed.agentId, seed.issueId);

    // The wake produced a real run instead of a parked receipt.
    expect(run).toMatchObject({ status: "queued", agentId: seed.agentId });
    const issueRuns = await runsForIssue(seed.issueId);
    expect(issueRuns).toHaveLength(1);
    expect(issueRuns[0]).toMatchObject({ status: "queued", contextSnapshot: { issueId: seed.issueId } });
    expect(await executionWaits(seed.agentId)).toHaveLength(0);

    // The hold is released in place: bookkeeping and the recorded no-replay
    // decision survive, only the release marker is added.
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).toBeNull();
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect(action!.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toEqual(expect.any(String));
    expect(action!.evidence.settledNoReplayHoldRelease).toMatchObject({
      cause: "legacy_execution_requires_reconciliation",
      sourceRunId: seed.sourceRunId,
      agentId: seed.agentId,
      actorType: "system",
    });

    // A second wake on the now-released issue neither re-releases nor re-parks.
    const releasedAt = action!.evidence.settledNoReplayHoldReleasedAt;
    await wakeIssue(seed.agentId, seed.issueId);
    const [after] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(after!.evidence.settledNoReplayHoldReleasedAt).toBe(releasedAt);
    expect(await executionWaits(seed.agentId)).toHaveLength(0);
  });

  it.each(["user", "system"] as const)("never releases a settled hold for an unadmitted comment wake (%s)", async actorType => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked" });
    const wake = await heartbeatService(db).wakeup(seed.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: actorType, requestedByActorId: "blocker-owner",
      payload: { issueId: seed.issueId, commentId: randomUUID() },
      contextSnapshot: { issueId: seed.issueId },
    });
    expect(wake).toBeNull();
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it.each([
    ["automation", "issue_continuation_needed", "system"],
    ["automation", "issue_blockers_resolved", "system"],
    ["automation", "issue_assigned", "system"],
    ["assignment", "issue_continuation_needed", "system"],
    ["assignment", "issue_assigned", "agent"],
  ] as const)("preserves the settled hold for non-assignment authority (%s/%s/%s)", async (source, reason, actorType) => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", replay: "blocked" });
    const wake = await heartbeatService(db).wakeup(seed.agentId, {
      source, triggerDetail: "system", reason,
      requestedByActorType: actorType, requestedByActorId: "assignment",
      payload: { issueId: seed.issueId }, contextSnapshot: { issueId: seed.issueId },
    });
    expect(wake).toBeNull();
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T2: an open recovery action still parks the wake", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "todo", recoveryStatus: "active", replay: "blocked" });
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();

    await wakeIssue(seed.agentId, seed.issueId);

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped",
      reason: "execution_reconciliation_required",
      payload: { executionWait: { recoveryActionId: seed.actionId } },
    });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action!.status).toBe("active");
    expect(action!.evidence.settledNoReplayHoldReleasedAt).toBeUndefined();
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T3: a human owner still parks the wake — a person decides", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked", assigneeUserId: randomUUID() });

    await wakeIssue(seed.agentId, seed.issueId);

    const waits = await executionWaits(seed.agentId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T4: an issue outside todo/blocked still parks the wake", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "in_progress", replay: "blocked" });

    await wakeIssue(seed.agentId, seed.issueId);

    expect(await runsForIssue(seed.issueId)).toHaveLength(0);
    expect(await executionWaits(seed.agentId)).toHaveLength(1);
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });

  it("T5: recovery-actions surfaces the settled action referenced by executionBlocker", async () => {
    const seed = await seedBlockedIssue({ issueStatus: "blocked", replay: "blocked" });

    const response = await request(app(seed.companyId)).get(`/api/issues/${seed.issueId}/recovery-actions`);

    expect(response.status).toBe(200);
    expect(response.body.active).toBeNull();
    expect(response.body.actions.map((action: { id: string }) => action.id)).toEqual([seed.actionId]);
    expect(response.body.referencedByExecutionBlocker).toBe(seed.actionId);
    // Surfacing is read-only: the blocker is untouched by the read.
    expect(await getExecutionBlocker(db, seed.companyId, seed.issueId)).not.toBeNull();
  });
});
