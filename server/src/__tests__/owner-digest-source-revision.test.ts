import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, documents, documentRevisions, issueDocuments, issues } from "@paperclipai/db";
import * as queueModule from "../services/owner-digest-human-wait-queue.js";
import { documentService } from "../services/documents.js";
import type { Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("dark owner digest source revision", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("owner-digest-source-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), originIssueId = randomUUID();
    const documentId = randomUUID(), revisionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Source fixture", issuePrefix: companyId });
    await db.insert(issues).values({ id: originIssueId, companyId, title: "Origin", status: "blocked" });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Immutable source", latestRevisionId: revisionId });
    await db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, body: "Immutable source" });
    const [link] = await db.insert(issueDocuments).values({ companyId, issueId: originIssueId, documentId, key: "owner-question" }).returning();
    return { companyId, originIssueId, documentId, revisionId, linkId: link.id };
  }

  it.each(["missing", "unlinked", "foreign-link", "foreign-document", "foreign-revision", "foreign-origin", "stale", "body-drift", "number-drift", "format-drift"] as const)("denies %s before calling a writer", async (reason) => {
    const input = await fixture();
    const foreign = randomUUID();
    await db.insert(companies).values({ id: foreign, name: "Foreign", issuePrefix: foreign });
    if (reason === "missing") input.revisionId = randomUUID();
    if (reason === "unlinked") await db.delete(issueDocuments).where(eq(issueDocuments.id, input.linkId));
    if (reason === "foreign-link") await db.update(issueDocuments).set({ companyId: foreign }).where(eq(issueDocuments.id, input.linkId));
    if (reason === "foreign-document") await db.update(documents).set({ companyId: foreign }).where(eq(documents.id, input.documentId));
    if (reason === "foreign-revision") await db.update(documentRevisions).set({ companyId: foreign }).where(eq(documentRevisions.id, input.revisionId));
    if (reason === "foreign-origin") await db.update(issues).set({ companyId: foreign }).where(eq(issues.id, input.originIssueId));
    if (reason === "stale") await db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, input.documentId));
    if (reason === "body-drift") await db.update(documents).set({ latestBody: "Changed without revision" }).where(eq(documents.id, input.documentId));
    if (reason === "number-drift") await db.update(documents).set({ latestRevisionNumber: 2 }).where(eq(documents.id, input.documentId));
    if (reason === "format-drift") await db.update(documents).set({ format: "other" }).where(eq(documents.id, input.documentId));
    const writer = vi.fn(async () => "unsafe");
    const before = await db.select().from(issues).where(eq(issues.id, input.originIssueId));
    await expect(queueModule.withOwnerDigestSourceRevision(db, input, writer)).rejects.toBeInstanceOf(queueModule.OwnerDigestHumanWaitUnauthorizedError);
    expect(writer).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.id, input.originIssueId))).toEqual(before);
  });

  it.each(["reader-first", "revision-first"] as const)("orders source revision edits at commit: %s", async (order) => {
    const input = await fixture();
    let release!: () => void, ready!: (pid: number) => void, failed!: (error: unknown) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const writer = vi.fn(async () => "verified");
    const holder = order === "reader-first"
      ? queueModule.withOwnerDigestSourceRevision(db, input, async (tx) => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        ready(Number(backend.pid)); await barrier; return "verified";
      })
      : db.transaction(async (tx) => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        await tx.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, input.documentId));
        ready(Number(backend.pid)); await barrier;
      });
    void holder.catch(failed);
    let contender: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pid = await held;
      contender = Promise.allSettled([order === "reader-first"
        ? db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, input.documentId)).then((r) => r)
        : queueModule.withOwnerDigestSourceRevision(db, input, writer)]);
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
          and wait_event_type = 'Lock' and (query like 'update "documents"%' or query like '%from "documents"%for share%')`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release(); await Promise.allSettled([holder, ...(contender ? [contender] : [])]);
    }
    await holder;
    if (order === "reader-first") expect((await contender!)[0].status).toBe("fulfilled");
    else {
      expect((await contender!)[0]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ name: "OwnerDigestHumanWaitUnauthorizedError" }) });
      expect(writer).not.toHaveBeenCalled();
    }
    await expect(queueModule.withOwnerDigestSourceRevision(db, input, writer)).rejects.toBeInstanceOf(queueModule.OwnerDigestHumanWaitUnauthorizedError);
  });

  it("serializes with the real document upsert writer without a deadlock", async () => {
    const input = await fixture();
    let release!: () => void, ready!: (pid: number) => void, failed!: (error: unknown) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const holder = db.transaction(async (tx) => {
      await tx.update(documents).set({ latestBody: "Writer owns document" }).where(eq(documents.id, input.documentId));
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(backend.pid)); await barrier;
      return documentService(tx as unknown as Db).upsertIssueDocument({
        issueId: input.originIssueId, key: "owner-question", format: "markdown",
        body: "Real writer revision", baseRevisionId: input.revisionId,
      });
    });
    void holder.catch(failed);
    const writer = vi.fn(async () => "unsafe");
    let contender: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pid = await held;
      contender = Promise.allSettled([queueModule.withOwnerDigestSourceRevision(db, input, writer)]);
      await vi.waitFor(async () => {
        expect(await db.execute(sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
          and wait_event_type = 'Lock'`)).toHaveLength(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release(); await Promise.allSettled([holder, ...(contender ? [contender] : [])]);
    }
    const outcomes = await Promise.allSettled([holder]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect((await contender!)[0]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ name: "OwnerDigestHumanWaitUnauthorizedError" }) });
    expect(writer).not.toHaveBeenCalled();
    const [document] = await db.select().from(documents).where(eq(documents.id, input.documentId));
    expect(document.latestBody).toBe("Real writer revision");
    await queueModule.withOwnerDigestSourceRevision(db, { ...input, revisionId: document.latestRevisionId! }, async (_tx, source) => {
      expect(source.body).toBe("Real writer revision");
    });
  });

  it("serializes with the real document delete writer without a deadlock", async () => {
    const input = await fixture();
    let release!: () => void, ready!: (pid: number) => void, failed!: (error: unknown) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(documents).where(eq(documents.id, input.documentId)).for("share");
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(backend.pid)); await barrier;
      return queueModule.withOwnerDigestSourceRevision(tx as unknown as Db, input, async (_inner, source) => source.body);
    });
    void holder.catch(failed);
    let contender: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pid = await held;
      contender = Promise.allSettled([documentService(db).deleteIssueDocument(input.originIssueId, "owner-question")]);
      await vi.waitFor(async () => {
        expect(await db.execute(sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
          and wait_event_type = 'Lock'`)).toHaveLength(1);
      }, { timeout: 3_000, interval: 10 });
    } finally {
      release(); await Promise.allSettled([holder, ...(contender ? [contender] : [])]);
    }
    await expect(holder).resolves.toBe("Immutable source");
    expect((await contender!)[0].status).toBe("fulfilled");
    expect(await db.select().from(documents).where(eq(documents.id, input.documentId))).toHaveLength(0);
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.id, input.linkId))).toHaveLength(0);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.id, input.revisionId))).toHaveLength(0);
    const writer = vi.fn(async () => "unsafe");
    await expect(queueModule.withOwnerDigestSourceRevision(db, input, writer)).rejects.toBeInstanceOf(queueModule.OwnerDigestHumanWaitUnauthorizedError);
    expect(writer).not.toHaveBeenCalled();
  });

  it("rolls dependent writes back when the internal operation fails", async () => {
    const input = await fixture();
    await expect(queueModule.withOwnerDigestSourceRevision(db, input, async (tx) => {
      await tx.update(issues).set({ title: "Uncommitted" }).where(eq(issues.id, input.originIssueId));
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    expect((await db.select().from(issues).where(eq(issues.id, input.originIssueId)))[0].title).toBe("Origin");
  });

  it("resolves a current attached source revision inside the mutation transaction", async () => {
    const input = await fixture();
    const source = await queueModule.withOwnerDigestSourceRevision(db, input, async (tx, resolved) => {
      await tx.update(issues).set({ title: "Source checked" }).where(eq(issues.id, input.originIssueId));
      return resolved;
    });
    expect(source).toEqual({ companyId: input.companyId, originIssueId: input.originIssueId, documentId: input.documentId,
      revisionId: input.revisionId, key: "owner-question", body: "Immutable source", format: "markdown", revisionNumber: 1 });
    expect((await db.select().from(issues).where(eq(issues.id, input.originIssueId)))[0].title).toBe("Source checked");
  });
});
