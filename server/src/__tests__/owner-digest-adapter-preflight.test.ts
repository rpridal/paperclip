import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, documents, documentRevisions, issueDocuments, issues, ownerDigestHumanWaitAuthorizations, ownerDigestHumanWaits } from "@paperclipai/db";
import * as adapter from "../services/owner-digest-adapter-preflight.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("dark adapter source preflight, not authorization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("digest-preflight-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), originIssueId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Preflight", issuePrefix: companyId });
    await db.insert(issues).values({ id: originIssueId, companyId, title: "Origin", status: "blocked" });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Not authoritative", latestRevisionId: revisionId });
    await db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, body: "Not authoritative" });
    await db.insert(issueDocuments).values({ companyId, issueId: originIssueId, documentId, key: "owner-question" });
    return { companyId, request: { version: 1, originIssueId, source: { documentId, key: "owner-question", revisionId }, questionIds: ["q-1"], idempotencyKey: "exact-key" } };
  }
  it.each(["principalId", "runId", "companyId", "inboxUserId", "producerPrincipalId", "audience", "approvalScope", "allowed", "provider"])("rejects caller authority field %s without interpreting source", async (field) => {
    const { companyId, request } = await fixture();
    await expect(adapter.ownerDigestAdapterPreflight(db, companyId, { ...request, [field]: true })).rejects.toMatchObject({ code: "owner_digest_adapter_invalid_request" });
  });
  it.each(["duplicate", "whitespace", "empty", "nested-extra", "version", "document", "key"])("denies invalid request/selector %s", async (reason) => {
    const { companyId, request } = await fixture();
    const modified: any = structuredClone(request);
    if (reason === "duplicate") modified.questionIds = ["q-1", "q-1"];
    if (reason === "whitespace") modified.questionIds = [" q-1"];
    if (reason === "empty") modified.questionIds = [];
    if (reason === "nested-extra") modified.source.authorized = true;
    if (reason === "version") modified.version = "1";
    if (reason === "document") modified.source.documentId = randomUUID();
    if (reason === "key") modified.source.key = "different";
    await expect(adapter.ownerDigestAdapterPreflight(db, companyId, modified)).rejects.toMatchObject({ code: ["document", "key"].includes(reason) ? "owner_digest_adapter_source_mismatch" : "owner_digest_adapter_invalid_request" });
  });
  it.each(["stale", "detached", "foreign"])("keeps source identity denial distinct: %s", async (reason) => {
    const { companyId, request } = await fixture();
    if (reason === "stale") await db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, request.source.documentId));
    if (reason === "detached") await db.delete(issueDocuments).where(eq(issueDocuments.documentId, request.source.documentId));
    const company = reason === "foreign" ? randomUUID() : companyId;
    await expect(adapter.ownerDigestAdapterPreflight(db, company, request)).rejects.toMatchObject({ name: "OwnerDigestHumanWaitUnauthorizedError" });
    expect(await db.select().from(ownerDigestHumanWaitAuthorizations).where(eq(ownerDigestHumanWaitAuthorizations.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.companyId, companyId))).toHaveLength(0);
  });
  it("captures nested selectors before async database work without normalizing them", async () => {
    const { companyId, request } = await fixture();
    request.source.key = "wrong-key";
    const result = adapter.ownerDigestAdapterPreflight(db, companyId, request);
    request.source.key = "owner-question";
    await expect(result).rejects.toMatchObject({ code: "owner_digest_adapter_source_mismatch" });
  });
  it("denies a valid current source without authority and writes no ledger or queue", async () => {
    const { companyId, request } = await fixture();
    await expect(adapter.ownerDigestAdapterPreflight(db, companyId, request)).rejects.toMatchObject({ code: "owner_digest_source_authority_unavailable" });
    expect(await db.select().from(ownerDigestHumanWaitAuthorizations).where(eq(ownerDigestHumanWaitAuthorizations.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(ownerDigestHumanWaits).where(eq(ownerDigestHumanWaits.companyId, companyId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, request.originIssueId)))[0].status).toBe("blocked");
  });
});
