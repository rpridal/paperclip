import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { withOwnerDigestSourceRevision } from "./owner-digest-human-wait-queue.js";

const exactToken = z.string().regex(/^\S+$/);
const requestV1 = z.object({
  version: z.literal(1), originIssueId: z.string().uuid(),
  source: z.object({ documentId: z.string().uuid(), key: exactToken, revisionId: z.string().uuid() }).strict(),
  questionIds: z.array(exactToken).min(1).refine((ids) => new Set(ids).size === ids.length),
  idempotencyKey: exactToken,
  candidateAskIssueId: z.string().uuid().optional(),
}).strict();

export class OwnerDigestAdapterPreflightError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnerDigestAdapterPreflightError"; }
}

/** Dark negative boundary only: not a route, authenticated authorizer or producer. */
export async function ownerDigestAdapterPreflight(db: Db, companyId: string, request: unknown): Promise<never> {
  // Parse synchronously, including cloning nested source/IDs before any wait.
  const parsed = requestV1.safeParse(request);
  if (!parsed.success) throw new OwnerDigestAdapterPreflightError("owner_digest_adapter_invalid_request");
  const captured = parsed.data;
  return withOwnerDigestSourceRevision(db, { companyId, originIssueId: captured.originIssueId, revisionId: captured.source.revisionId }, async (_tx, source) => {
    if (source.documentId !== captured.source.documentId || source.key !== captured.source.key) {
      throw new OwnerDigestAdapterPreflightError("owner_digest_adapter_source_mismatch");
    }
    // Current source identity is NOT evidence of owner audience or permission.
    // No injectable allow-provider, writer callback, ledger grant or fallback.
    throw new OwnerDigestAdapterPreflightError("owner_digest_source_authority_unavailable");
  });
}
