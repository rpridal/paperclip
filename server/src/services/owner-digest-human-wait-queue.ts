import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, ownerDigestHumanWaitAuthorizations, ownerDigestHumanWaits } from "@paperclipai/db";

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

export function ownerDigestHumanWaitQueueService(db: Db) {
  async function authorized(input: { companyId: string; originIssueId: string; inboxUserId: string; answerScope: AnswerScope; producerPrincipalId: string }) {
    const [origin] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.originIssueId), eq(issues.companyId, input.companyId))).limit(1);
    if (!origin) throw new OwnerDigestHumanWaitUnauthorizedError();
    const [binding] = await db.select({ id: ownerDigestHumanWaitAuthorizations.id }).from(ownerDigestHumanWaitAuthorizations).where(and(
      eq(ownerDigestHumanWaitAuthorizations.companyId, input.companyId),
      eq(ownerDigestHumanWaitAuthorizations.originIssueId, input.originIssueId),
      eq(ownerDigestHumanWaitAuthorizations.inboxUserId, input.inboxUserId),
      eq(ownerDigestHumanWaitAuthorizations.producerPrincipalId, input.producerPrincipalId),
      sameScope(ownerDigestHumanWaitAuthorizations.answerScope, input.answerScope),
    )).limit(1);
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
    async enqueue(input: { companyId: string; originIssueId: string; inboxUserId: string; answerScope: AnswerScope; producerPrincipalId: string }) {
      await authorized(input);
      const [existing] = await db.select().from(ownerDigestHumanWaits).where(and(
        eq(ownerDigestHumanWaits.companyId, input.companyId), eq(ownerDigestHumanWaits.originIssueId, input.originIssueId),
        eq(ownerDigestHumanWaits.inboxUserId, input.inboxUserId), sameScope(ownerDigestHumanWaits.answerScope, input.answerScope),
      )).limit(1);
      if (existing) return { ...existing, duplicate: true };
      const [created] = await db.insert(ownerDigestHumanWaits).values(input).onConflictDoNothing().returning();
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
