import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
  issueRelations,
  issueThreadInteractions,
  ownerDigestHumanWaitAuthorizations,
  ownerDigestHumanWaits,
} from "@paperclipai/db";
import {
  OwnerDigestHumanWaitUnauthorizedError,
  ownerDigestHumanWaitQueueService,
} from "../services/owner-digest-human-wait-queue.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("owner digest human-wait queue", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const scope = { kind: "owner_only", questionIds: ["q-1"] };
  let companyId: string;
  let originIssueId: string;
  let inboxUserId: string;
  let producerPrincipalId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("owner-digest-human-wait-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    originIssueId = randomUUID();
    inboxUserId = "owner-fixture";
    producerPrincipalId = "native-owner-digest-fixture";
    await db.insert(companies).values({ id: companyId, name: "Queue fixture", issuePrefix: "ODQ" });
    await db.insert(issues).values({ id: originIssueId, companyId, title: "Human wait", status: "blocked" });
    await authorize(scope);
  }, 30_000);

  async function authorize(answerScope: Record<string, unknown>) {
    await db.insert(ownerDigestHumanWaitAuthorizations).values({
      companyId, originIssueId, inboxUserId, answerScope, producerPrincipalId,
    });
  }
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function carrierFixture(label: string) {
    const answerScope = { kind: "owner_only", questionIds: [label] };
    await authorize(answerScope);
    const queue = ownerDigestHumanWaitQueueService(db);
    const row = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope, producerPrincipalId });
    const askIssueId = randomUUID();
    // Identity comes from the binding, deliberately not from an ASK title.
    await db.insert(issues).values({ id: askIssueId, companyId, title: "Untitled carrier", status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: askIssueId, relatedIssueId: originIssueId, type: "blocks" });
    return { queue, row, askIssueId, input: { id: row.id, companyId, producerPrincipalId, askIssueId } };
  }

  it("binds one distinct ASK carrier idempotently without changing the blocked origin", async () => {
    const { queue, row, askIssueId, input } = await carrierFixture("carrier");
    const first = await queue.bindAsk(input);
    expect(first).toMatchObject({ id: row.id, askIssueId, status: "queued", duplicate: false });
    expect(await queue.bindAsk(input)).toMatchObject({ id: row.id, askIssueId, duplicate: true });
    const [origin] = await db.select().from(issues).where(eq(issues.id, originIssueId));
    expect(origin.status).toBe("blocked");
    const [ask] = await db.select().from(issues).where(eq(issues.id, askIssueId));
    expect(ask).toMatchObject({ status: "todo", assigneeAgentId: null });
  });

  it.each(["foreign", "no-edge", "pending", "answered", "active"] as const)("rejects unsafe carrier %s without rewriting legacy interactions", async (reason) => {
    const { queue, row, askIssueId, input } = await carrierFixture(`unsafe-${reason}`);
    if (reason === "foreign") {
      const foreign = randomUUID();
      await db.insert(companies).values({ id: foreign, name: "Foreign carrier", issuePrefix: "FC" });
      await db.update(issues).set({ companyId: foreign }).where(eq(issues.id, askIssueId));
    }
    if (reason === "no-edge") await db.delete(issueRelations).where(eq(issueRelations.issueId, askIssueId));
    if (reason === "active") await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, askIssueId));
    if (reason === "pending" || reason === "answered") await db.insert(issueThreadInteractions).values({ companyId, issueId: askIssueId, kind: "request_confirmation", status: reason === "pending" ? "pending" : "resolved", payload: {} });
    const before = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, askIssueId));
    await expect(queue.bindAsk(input)).rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    const [saved] = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.id, row.id));
    expect(saved.askIssueId).toBeNull();
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, askIssueId))).toEqual(before);
  });

  it("never rebinds an ASK carrier, even through a direct database edit", async () => {
    const { queue, row, input } = await carrierFixture("immutable-carrier");
    await queue.bindAsk(input);
    const other = randomUUID();
    await db.insert(issues).values({ id: other, companyId, title: "Other", status: "todo" });
    await expect(db.update(ownerDigestHumanWaits).set({ askIssueId: other }).where(eq(ownerDigestHumanWaits.id, row.id))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/immutable/i) }) });
  });

  it("does not accept caller supplied carrier identity during enqueue", async () => {
    const answerScope = { kind: "owner_only", questionIds: ["enqueue-carrier-bypass"] };
    await authorize(answerScope);
    const askIssueId = randomUUID();
    await db.insert(issues).values({ id: askIssueId, companyId, title: "Unbound", status: "todo" });
    const queue = ownerDigestHumanWaitQueueService(db);
    const untypedInput = { companyId, originIssueId, inboxUserId, answerScope, producerPrincipalId, askIssueId };
    expect(await queue.enqueue(untypedInput)).toMatchObject({ askIssueId: null });
  });

  it("serializes concurrent carrier bindings and refuses replacing the winner", async () => {
    const { queue, askIssueId, input } = await carrierFixture("concurrent-carrier");
    const results = await Promise.all(Array.from({ length: 8 }, () => queue.bindAsk(input)));
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.askIssueId === askIssueId)).toBe(true);
    await expect(queue.bindAsk({ ...input, askIssueId: originIssueId })).rejects.toThrow(/transition/i);
  });

  it("persists an authorized wait once and presents it idempotently", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const first = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: scope, producerPrincipalId });
    const duplicate = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: scope, producerPrincipalId });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true, status: "queued" });
    expect(await queue.present({ id: first.id, companyId, producerPrincipalId })).toMatchObject({ status: "presented", duplicate: false });
    expect(await queue.present({ id: first.id, companyId, producerPrincipalId })).toMatchObject({ status: "presented", duplicate: true });
  });

  it("coalesces concurrent enqueue without rejecting an authorized retry", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const concurrentScope = { kind: "owner_only", questionIds: ["concurrent"] };
    await authorize(concurrentScope);
    // Hold inserts briefly so independent PostgreSQL sessions all observe no row.
    await db.$client.unsafe(`CREATE FUNCTION test_queue_insert_delay() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_queue_insert_delay BEFORE INSERT ON owner_digest_human_waits FOR EACH ROW EXECUTE FUNCTION test_queue_insert_delay();`);
    let results;
    try {
      results = await Promise.all(Array.from({ length: 8 }, () => queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: concurrentScope, producerPrincipalId })));
    } finally {
      await db.$client.unsafe("DROP TRIGGER test_queue_insert_delay ON owner_digest_human_waits; DROP FUNCTION test_queue_insert_delay();");
    }
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(results.filter((row) => !row.duplicate)).toHaveLength(1);
  });

  async function raceTransitions(first: "cancel" | "present", stale: "cancel" | "present") {
    const queue = ownerDigestHumanWaitQueueService(db);
    const racingScope = { kind: "owner_only", questionIds: [`transition-race-${first}`] };
    await authorize(racingScope);
    const row = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: racingScope, producerPrincipalId });
    const input = { id: row.id, companyId, producerPrincipalId };
    let release!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { release = resolve; });
    let ready!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const updated = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const winner = db.transaction(async (tx) => {
      // This service uses only select/insert/update; the transaction provides
      // those same real Drizzle operations, not a mocked service or connection.
      const transactionalQueue = ownerDigestHumanWaitQueueService(tx as unknown as typeof db);
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      const result = await transactionalQueue[first](input);
      ready(Number(backend.pid));
      await commitBarrier;
      return result;
    });
    void winner.catch(failed);
    let staleResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const holderPid = await updated;
      // The winner has updated but not committed. The other session must read
      // the old queued version and then block at its real UPDATE/CAS boundary.
      staleResult = Promise.allSettled([queue[stale](input)]);
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity
          where ${holderPid} = any(pg_blocking_pids(pid))
          and wait_event_type = 'Lock'
          and query like 'update "owner_digest_human_waits"%'`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release();
      // Always finish both sessions, including on an assertion failure.
      await Promise.allSettled([winner, ...(staleResult ? [staleResult] : [])]);
    }
    expect(await winner).toMatchObject({ status: first === "cancel" ? "cancelled" : "presented", duplicate: false });
    expect((await staleResult!)[0]).toMatchObject({
      status: "rejected", reason: expect.objectContaining({ name: "OwnerDigestHumanWaitTransitionError" }),
    });
    const [saved] = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.id, row.id));
    expect(saved.status).toBe(first === "cancel" ? "cancelled" : "presented");
    return { queue, input };
  }

  it("does not overwrite a committed terminal state with stale presentation", async () => {
    const { queue, input } = await raceTransitions("cancel", "present");
    await expect(queue.present(input)).rejects.toThrow(/transition/i);
    expect(await queue.cancel(input)).toMatchObject({ status: "cancelled", duplicate: true });
  });

  it("allows presentation to commit first and cancellation retry to converge", async () => {
    const { queue, input } = await raceTransitions("present", "cancel");
    expect(await queue.cancel(input)).toMatchObject({ status: "cancelled", duplicate: false });
    await expect(queue.present(input)).rejects.toThrow(/transition/i);
  });

  it("keeps routing fields immutable and gives a changed scope a new queue item", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const first = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: scope, producerPrincipalId });
    const changedScope = { kind: "owner_only", questionIds: ["q-2"] };
    await authorize(changedScope);
    const changed = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: changedScope, producerPrincipalId });
    expect(changed.id).not.toBe(first.id);
    await expect(db.update(ownerDigestHumanWaits).set({ inboxUserId: "other-owner" }).where(eq(ownerDigestHumanWaits.id, first.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/immutable/i) }),
    });
    const [row] = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.id, first.id));
    expect(row).toMatchObject({ companyId, originIssueId, inboxUserId, answerScope: scope, status: "presented" });
  });

  it("rejects changed scope without creating another authorization or queue row", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const before = await db.select().from(ownerDigestHumanWaitAuthorizations);
    await expect(queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: { kind: "owner_only", questionIds: ["unreviewed-change"] }, producerPrincipalId })).rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    expect(await db.select().from(ownerDigestHumanWaitAuthorizations)).toEqual(before);
  });

  it.each(["enqueue", "present"] as const)("rejects %s when an overlapping binding revocation commits first", async (operation) => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const revokedScope = { kind: "owner_only", questionIds: [`revoked-${operation}`] };
    await authorize(revokedScope);
    const input = { companyId, originIssueId, inboxUserId, answerScope: revokedScope, producerPrincipalId };
    const queued = operation === "present" ? await queue.enqueue(input) : undefined;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let ready!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const deleted = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const revocation = db.transaction(async (tx) => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`delete from owner_digest_human_wait_authorizations
        where company_id = ${companyId} and answer_scope = ${JSON.stringify(revokedScope)}::jsonb`);
      ready(Number(backend.pid));
      await barrier;
    });
    void revocation.catch(failed);
    let attempt: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let settled = false;
    try {
      const holderPid = await deleted;
      attempt = Promise.allSettled([operation === "enqueue" ? queue.enqueue(input)
        : queue.present({ id: queued!.id, companyId, producerPrincipalId })]);
      void attempt.then(() => { settled = true; });
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity
          where ${holderPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
        // The unsafe baseline may finish before DELETE commits. That is a
        // measured violation, not an assumption about Promise invocation order.
        expect(settled || waiting.length === 1).toBe(true);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release();
      await Promise.allSettled([revocation, ...(attempt ? [attempt] : [])]);
    }
    await revocation;
    expect((await attempt!)[0]).toMatchObject({ status: "rejected",
      reason: expect.objectContaining({ name: "OwnerDigestHumanWaitUnauthorizedError" }) });
    const rows = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.answerScope, revokedScope));
    if (operation === "enqueue") expect(rows).toHaveLength(0);
    else expect(rows).toMatchObject([{ id: queued!.id, status: "queued", presentedAt: null }]);
  });

  it("orders revocation after a mutation commit and denies subsequent duplicate retries", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const answerScope = { kind: "owner_only", questionIds: ["mutation-first"] };
    await authorize(answerScope);
    const row = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope, producerPrincipalId });
    const input = { id: row.id, companyId, producerPrincipalId };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let ready!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const updated = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const mutation = db.transaction(async (tx) => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      const result = await ownerDigestHumanWaitQueueService(tx as unknown as typeof db).present(input);
      ready(Number(backend.pid));
      await barrier;
      return result;
    });
    void mutation.catch(failed);
    let revocation: Promise<unknown> | undefined;
    try {
      const holderPid = await updated;
      revocation = db.execute(sql`delete from owner_digest_human_wait_authorizations
        where company_id = ${companyId} and answer_scope = ${JSON.stringify(answerScope)}::jsonb`).then((result) => result);
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity
          where ${holderPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'
          and query like 'delete from owner_digest_human_wait_authorizations%'`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release();
      await Promise.allSettled([mutation, ...(revocation ? [revocation] : [])]);
    }
    expect(await mutation).toMatchObject({ status: "presented", duplicate: false });
    await revocation;
    await expect(queue.present(input)).rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    await expect(queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope, producerPrincipalId }))
      .rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    const [saved] = await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.id, row.id));
    expect(saved).toMatchObject({ status: "presented", companyId, originIssueId, inboxUserId, answerScope });
    expect(saved.presentedAt).not.toBeNull();
  });

  it("rejects cross-company origin even when an invalid binding was seeded", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: "OTHER" });
    await db.insert(ownerDigestHumanWaitAuthorizations).values({ companyId: otherCompanyId, originIssueId, inboxUserId, answerScope: scope, producerPrincipalId });
    const queue = ownerDigestHumanWaitQueueService(db);
    await expect(queue.enqueue({ companyId: otherCompanyId, originIssueId, inboxUserId, answerScope: scope, producerPrincipalId })).rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    expect(await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.companyId, otherCompanyId))).toHaveLength(0);
  });

  it("allows only authorized lifecycle mutations and supports answered and cancelled terminals", async () => {
    const queue = ownerDigestHumanWaitQueueService(db);
    const answeredScope = { kind: "owner_only", questionIds: ["q-answered"] };
    await authorize(answeredScope);
    const answered = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: answeredScope, producerPrincipalId });
    await expect(queue.answer({ id: answered.id, companyId, producerPrincipalId: "wrong" })).rejects.toBeInstanceOf(OwnerDigestHumanWaitUnauthorizedError);
    await queue.present({ id: answered.id, companyId, producerPrincipalId });
    expect(await queue.answer({ id: answered.id, companyId, producerPrincipalId })).toMatchObject({ status: "answered" });
    const cancelledScope = { kind: "owner_only", questionIds: ["q-cancelled"] };
    await authorize(cancelledScope);
    const cancelled = await queue.enqueue({ companyId, originIssueId, inboxUserId, answerScope: cancelledScope, producerPrincipalId });
    expect(await queue.cancel({ id: cancelled.id, companyId, producerPrincipalId })).toMatchObject({ status: "cancelled" });
    await expect(queue.present({ id: cancelled.id, companyId, producerPrincipalId })).rejects.toThrow(/transition/i);
  });
});
