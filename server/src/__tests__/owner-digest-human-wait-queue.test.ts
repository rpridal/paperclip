import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
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
