import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueRelations, issueThreadInteractions, ownerDigestHumanWaitAuthorizations, ownerDigestHumanWaits } from "@paperclipai/db";

type AnswerScope = Record<string, unknown>;
type WaitRow = typeof ownerDigestHumanWaits.$inferSelect;

export class OwnerDigestHumanWaitUnauthorizedError extends Error {
  constructor() { super("owner_digest_human_wait_unauthorized"); this.name = "OwnerDigestHumanWaitUnauthorizedError"; }
}

export class OwnerDigestHumanWaitTransitionError extends Error {
  constructor() { super("owner_digest_human_wait_invalid_transition"); this.name = "OwnerDigestHumanWaitTransitionError"; }
}

function sameScope(column: typeof ownerDigestHumanWaits.answerScope | typeof ownerDigestHumanWaitAuthorizations.answerScope, scope: AnswerScope) {
  return sql`${column} = ${JSON.stringify(scope)}::jsonb`;
}

function queueWithinTransaction(db: Db) {
  async function authorized(input: { companyId: string; originIssueId: string; inboxUserId: string; answerScope: AnswerScope; producerPrincipalId: string }) {
    // SHARE permits concurrent producers but orders origin edits and binding
    // revocation against this operation's commit, including duplicate retries.
    const [origin] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.originIssueId), eq(issues.companyId, input.companyId))).limit(1).for("share");
    if (!origin) throw new OwnerDigestHumanWaitUnauthorizedError();
    const [binding] = await db.select({ id: ownerDigestHumanWaitAuthorizations.id }).from(ownerDigestHumanWaitAuthorizations).where(and(
      eq(ownerDigestHumanWaitAuthorizations.companyId, input.companyId),
      eq(ownerDigestHumanWaitAuthorizations.originIssueId, input.originIssueId),
      eq(ownerDigestHumanWaitAuthorizations.inboxUserId, input.inboxUserId),
      eq(ownerDigestHumanWaitAuthorizations.producerPrincipalId, input.producerPrincipalId),
      sameScope(ownerDigestHumanWaitAuthorizations.answerScope, input.answerScope),
    )).limit(1).for("share");
    if (!binding) throw new OwnerDigestHumanWaitUnauthorizedError();
  }

  async function rowAndAuthorize(input: { id: string; companyId: string; producerPrincipalId: string }): Promise<WaitRow> {
    const [row] = await db.select().from(ownerDigestHumanWaits).where(and(eq(ownerDigestHumanWaits.id, input.id), eq(ownerDigestHumanWaits.companyId, input.companyId))).limit(1);
    if (!row) throw new OwnerDigestHumanWaitUnauthorizedError();
    await authorized({ ...row, producerPrincipalId: input.producerPrincipalId });
    return row;
  }

  async function transition(input: { id: string; companyId: string; producerPrincipalId: string }, status: "presented" | "answered" | "cancelled") {
    const row = await rowAndAuthorize(input);
    if (row.status === status) return { ...row, duplicate: true };
    if (row.status === "answered" || row.status === "cancelled" || (status === "answered" && row.status !== "presented")) throw new OwnerDigestHumanWaitTransitionError();
    const now = new Date();
    const [updated] = await db.update(ownerDigestHumanWaits).set({
      status,
      updatedAt: now,
      ...(status === "presented" ? { presentedAt: now } : {}),
      ...(status === "answered" ? { answeredAt: now } : {}),
      ...(status === "cancelled" ? { cancelledAt: now } : {}),
    }).where(and(eq(ownerDigestHumanWaits.id, row.id), eq(ownerDigestHumanWaits.status, row.status))).returning();
    if (!updated) {
      const latest = await rowAndAuthorize(input);
      if (latest.status === status) return { ...latest, duplicate: true };
      throw new OwnerDigestHumanWaitTransitionError();
    }
    return { ...updated, duplicate: false };
  }

  return {
    async bindAsk(input: { id: string; companyId: string; producerPrincipalId: string; askIssueId: string }) {
      await rowAndAuthorize(input);
      const [row] = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.id, input.id)).limit(1).for("update");
      if (row.askIssueId === input.askIssueId) return { ...row, duplicate: true };
      if (row.askIssueId || row.status !== "queued") throw new OwnerDigestHumanWaitTransitionError();
      if (input.askIssueId === row.originIssueId) throw new OwnerDigestHumanWaitUnauthorizedError();
      const [origin] = await db.select().from(issues).where(eq(issues.id, row.originIssueId)).limit(1);
      const [ask] = await db.select().from(issues).where(and(eq(issues.id, input.askIssueId), eq(issues.companyId, row.companyId))).limit(1).for("update");
      if (origin.status !== "blocked" || !ask || ask.status !== "todo" || ask.assigneeAgentId || ask.assigneeUserId || ask.checkoutRunId || ask.executionRunId) throw new OwnerDigestHumanWaitUnauthorizedError();
      const [edge] = await db.select({ id: issueRelations.id }).from(issueRelations).where(and(
        eq(issueRelations.companyId, row.companyId), eq(issueRelations.issueId, ask.id),
        eq(issueRelations.relatedIssueId, row.originIssueId), eq(issueRelations.type, "blocks"),
      )).limit(1).for("share");
      const [interaction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, ask.id)).limit(1);
      if (!edge || interaction) throw new OwnerDigestHumanWaitUnauthorizedError();
      const [bound] = await db.update(ownerDigestHumanWaits).set({ askIssueId: input.askIssueId, updatedAt: new Date() })
        .where(eq(ownerDigestHumanWaits.id, row.id)).returning();
      return { ...bound, duplicate: false };
    },
    async enqueue(input: { companyId: string; originIssueId: string; inboxUserId: string; answerScope: AnswerScope; producerPrincipalId: string }) {
      await authorized(input);
      const [existing] = await db.select().from(ownerDigestHumanWaits).where(and(
        eq(ownerDigestHumanWaits.companyId, input.companyId), eq(ownerDigestHumanWaits.originIssueId, input.originIssueId),
        eq(ownerDigestHumanWaits.inboxUserId, input.inboxUserId), sameScope(ownerDigestHumanWaits.answerScope, input.answerScope),
      )).limit(1);
      if (existing) return { ...existing, duplicate: true };
      const [created] = await db.insert(ownerDigestHumanWaits).values({
        companyId: input.companyId, originIssueId: input.originIssueId,
        inboxUserId: input.inboxUserId, answerScope: input.answerScope,
        producerPrincipalId: input.producerPrincipalId,
      }).onConflictDoNothing().returning();
      if (created) return { ...created, duplicate: false };
      const [winner] = await db.select().from(ownerDigestHumanWaits).where(and(
        eq(ownerDigestHumanWaits.companyId, input.companyId), eq(ownerDigestHumanWaits.originIssueId, input.originIssueId),
        eq(ownerDigestHumanWaits.inboxUserId, input.inboxUserId), sameScope(ownerDigestHumanWaits.answerScope, input.answerScope),
      )).limit(1);
      // A hash collision must fail closed, never reuse a different exact scope.
      if (!winner) throw new OwnerDigestHumanWaitUnauthorizedError();
      return { ...winner, duplicate: true };
    },
    present: (input: { id: string; companyId: string; producerPrincipalId: string }) => transition(input, "presented"),
    answer: (input: { id: string; companyId: string; producerPrincipalId: string }) => transition(input, "answered"),
    cancel: (input: { id: string; companyId: string; producerPrincipalId: string }) => transition(input, "cancelled"),
  };
}

/** Internal persistence only. A ledger binding is not an authenticated grant. */
export function ownerDigestHumanWaitQueueService(db: Db) {
  type Queue = ReturnType<typeof queueWithinTransaction>;
  function atomic<T>(operation: (queue: Queue) => Promise<T>) {
    return db.transaction(async (tx) => {
      // Drizzle transaction exposes the same query interface and nested
      // transactions use savepoints; locks survive until the outer commit.
      return operation(queueWithinTransaction(tx as unknown as Db));
    });
  }
  return {
    bindAsk: (input: Parameters<Queue["bindAsk"]>[0]) => atomic((queue) => queue.bindAsk(input)),
    enqueue: (input: Parameters<Queue["enqueue"]>[0]) => atomic((queue) => queue.enqueue(input)),
    present: (input: Parameters<Queue["present"]>[0]) => atomic((queue) => queue.present(input)),
    answer: (input: Parameters<Queue["answer"]>[0]) => atomic((queue) => queue.answer(input)),
    cancel: (input: Parameters<Queue["cancel"]>[0]) => atomic((queue) => queue.cancel(input)),
  };
}
