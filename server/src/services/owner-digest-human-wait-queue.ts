import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { documents, documentRevisions, issueDocuments, issues, issueRelations, issueThreadInteractions, ownerDigestHumanWaitAuthorizations, ownerDigestHumanWaits } from "@paperclipai/db";

/** Dark source identity only. No audience, permission or question-set authority. */
export async function withOwnerDigestSourceRevision<T>(db: Db,
  input: { companyId: string; originIssueId: string; revisionId: string },
  operation: (tx: Db, source: { companyId: string; originIssueId: string; documentId: string;
    revisionId: string; key: string; body: string; format: string; revisionNumber: number }) => Promise<T>,
): Promise<T> {
  const captured = { companyId: input.companyId, originIssueId: input.originIssueId, revisionId: input.revisionId };
  return db.transaction(async (tx) => {
    const [origin] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, captured.originIssueId), eq(issues.companyId, captured.companyId),
    )).limit(1).for("share");
    if (!origin) throw new OwnerDigestHumanWaitUnauthorizedError();
    // Discovery is not authority. Lock the document before any attachment,
    // matching upsert/delete writers, then revalidate the full joined source.
    // A planner-selected joined lock order can otherwise invert these locks.
    const [candidate] = await tx.select({ documentId: documentRevisions.documentId }).from(documentRevisions)
      .where(and(eq(documentRevisions.id, captured.revisionId), eq(documentRevisions.companyId, captured.companyId))).limit(1);
    if (!candidate) throw new OwnerDigestHumanWaitUnauthorizedError();
    const [document] = await tx.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.id, candidate.documentId), eq(documents.companyId, captured.companyId))).limit(1).for("share");
    if (!document) throw new OwnerDigestHumanWaitUnauthorizedError();
    const [source] = await tx.select({
      companyId: issueDocuments.companyId, originIssueId: issueDocuments.issueId,
      documentId: documents.id, revisionId: documentRevisions.id, key: issueDocuments.key,
      body: documentRevisions.body, format: documentRevisions.format, revisionNumber: documentRevisions.revisionNumber,
    }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, captured.originIssueId), eq(documents.id, document.id),
        eq(issueDocuments.companyId, captured.companyId), eq(documents.companyId, captured.companyId),
        eq(documentRevisions.companyId, captured.companyId), eq(documentRevisions.id, captured.revisionId),
        eq(documents.latestRevisionId, documentRevisions.id),
        eq(documents.latestBody, documentRevisions.body), eq(documents.format, documentRevisions.format),
        eq(documents.latestRevisionNumber, documentRevisions.revisionNumber)))
      .limit(1).for("share");
    if (!source) throw new OwnerDigestHumanWaitUnauthorizedError();
    // Locks and dependent writes share one commit; returning an ID alone would
    // lose the current-revision guarantee before a later enqueue/presentation.
    return operation(tx as unknown as Db, source);
  });
}

// Dark internal syntax only, not audience authorization or an approval grant.
// Categories match the existing owner-digest producer's reserved owner scopes.
const answerScopeV1 = z.object({
  version: z.literal(1),
  kind: z.literal("owner_only"),
  approvalScope: z.enum(["personal_account", "personal_credentials", "money", "irreversible_delete", "host_decommission_with_data"]),
  revisionId: z.string().uuid(),
  questionIds: z.array(z.string().regex(/^\S+$/)).min(1)
    .refine((ids) => new Set(ids).size === ids.length),
}).strict();

function captureAnswerScope(scope: AnswerScope) {
  const result = answerScopeV1.safeParse(scope);
  if (!result.success) throw new OwnerDigestHumanWaitUnauthorizedError();
  // Zod clones nested arrays; no caller reference survives an async boundary.
  return result.data;
}

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
    // Reject, never trim/coerce/default or upgrade an opaque legacy scope.
    // The exact original JSONB remains the immutable authorization identity.
    if (!answerScopeV1.safeParse(input.answerScope).success) throw new OwnerDigestHumanWaitUnauthorizedError();
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
    bindAsk: (input: Parameters<Queue["bindAsk"]>[0]) => {
      // Capture the exact routing identity before authorization can block.
      // A mutable caller must not retarget the write after ledger validation.
      const captured = { id: input.id, companyId: input.companyId,
        producerPrincipalId: input.producerPrincipalId, askIssueId: input.askIssueId };
      return atomic((queue) => queue.bindAsk(captured));
    },
    enqueue: async (input: Parameters<Queue["enqueue"]>[0]) => {
      const captured = { ...input, answerScope: captureAnswerScope(input.answerScope) };
      return atomic((queue) => queue.enqueue(captured));
    },
    present: (input: Parameters<Queue["present"]>[0]) => {
      const captured = { id: input.id, companyId: input.companyId, producerPrincipalId: input.producerPrincipalId };
      return atomic((queue) => queue.present(captured));
    },
    answer: (input: Parameters<Queue["answer"]>[0]) => {
      const captured = { id: input.id, companyId: input.companyId, producerPrincipalId: input.producerPrincipalId };
      return atomic((queue) => queue.answer(captured));
    },
    cancel: (input: Parameters<Queue["cancel"]>[0]) => {
      const captured = { id: input.id, companyId: input.companyId, producerPrincipalId: input.producerPrincipalId };
      return atomic((queue) => queue.cancel(captured));
    },
  };
}
