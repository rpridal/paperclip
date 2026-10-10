import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import type { Db } from '@paperclipai/db';
import { activityLog, companies, companyMemberships, issues } from '@paperclipai/db';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';

export const INTAKE_COMPANY_ID = 'b954377a-979e-461a-b568-44f9104f0512';
const identitySchema = z.object({
  id: z.literal('mista-intake-stall'), companyId: z.literal(INTAKE_COMPANY_ID),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/), issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  issuerUserId: z.string().min(1), credentialVersion: z.string().min(1).max(80),
}).strict();
export type IntakeGuardIdentity = z.infer<typeof identitySchema>;
export const findingSchema = z.object({
  type: z.literal('intake_stall'), episodeId: z.string().uuid(),
  reasons: z.array(z.enum(['queue_growing_without_completion', 'producer_enabled_without_completion_gate'])).min(1).max(2),
  observedAt: z.iso.datetime(), queued: z.number().int().nonnegative(), lastCompletedAt: z.iso.datetime().nullable(),
  producerSuspended: z.boolean(),
}).strict();
export type IntakeFinding = z.infer<typeof findingSchema>;
type FindingRow = { id: string; identifier?: string | null; status?: string; description?: string | null };
export interface IntakeGuardStore {
  authorize(identity: IntakeGuardIdentity): Promise<boolean>;
  list(identity: IntakeGuardIdentity): Promise<unknown[]>;
  audit(identity: IntakeGuardIdentity, outcome: string): Promise<void>;
  read(identity: IntakeGuardIdentity, id: string): Promise<FindingRow | null>;
  create(identity: IntakeGuardIdentity, finding: IntakeFinding): Promise<FindingRow>;
}
const owned = (identity: IntakeGuardIdentity) => and(eq(issues.companyId, identity.companyId),
  eq(issues.originKind, 'intake_guard_service'), eq(issues.originId, identity.id));
const projection = { id: issues.id, identifier: issues.identifier, title: issues.title,
  description: issues.description, status: issues.status, createdAt: issues.createdAt,
  assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId };
export function intakeGuardStore(db: Db): IntakeGuardStore {
  type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
  const assertCurrent = (identity: IntakeGuardIdentity) => {
    const current = identitySchema.safeParse(JSON.parse(process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY ?? 'null'));
    const now = Date.now();
    if (!current.success || Object.keys(identity).some(key =>
      identity[key as keyof IntakeGuardIdentity] !== current.data[key as keyof IntakeGuardIdentity])
      || now < Date.parse(identity.issuedAt) || now >= Date.parse(identity.expiresAt)
      || Date.parse(identity.expiresAt) - Date.parse(identity.issuedAt) > 30 * 86400000) {
      throw new Error('service authority changed');
    }
  };
  const operation = <T>(identity: IntakeGuardIdentity,
    work: (tx: Tx, company: typeof companies.$inferSelect) => Promise<T>) => db.transaction(async tx => {
    // Shared by all replicas; order company -> issuer avoids a check-before-lock race.
    const [company] = await tx.select().from(companies).where(eq(companies.id, identity.companyId)).for('update');
    if (!company || company.status !== 'active') throw new Error('company unavailable');
    const [member] = await tx.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, identity.companyId), eq(companyMemberships.principalType, 'user'),
      eq(companyMemberships.principalId, identity.issuerUserId), eq(companyMemberships.status, 'active'),
      inArray(companyMemberships.membershipRole, ['owner', 'admin', 'operator', 'member']))).for('share');
    if (!member) throw new Error('issuer unavailable');
    assertCurrent(identity);
    const result = await work(tx, company);
    assertCurrent(identity);
    // Membership/company locks are held through COMMIT. Config cutovers still require
    // admission-stop + all-process/DB drain; an env update is NOT an atomic DB fence.
    return result;
  });
  return {
    authorize: async identity => {
      const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
        .innerJoin(companies, eq(companyMemberships.companyId, companies.id)).where(and(
          eq(companies.id, identity.companyId), eq(companies.status, 'active'),
          eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, identity.issuerUserId),
          eq(companyMemberships.status, 'active'), inArray(companyMemberships.membershipRole, ['owner', 'admin', 'operator', 'member'])));
      return !!member;
    },
    list: async identity => operation(identity, async tx => tx.select(projection).from(issues).where(owned(identity))),
    read: async (identity, id) => operation(identity, async tx => {
      const [row] = await tx.select(projection).from(issues).where(and(owned(identity), eq(issues.id, id)));
      if (!row) return null;
      await tx.insert(activityLog).values({ companyId: identity.companyId, actorType: 'service', actorId: identity.id,
        action: 'intake_guard.readback', entityType: 'issue', entityId: row.id,
        details: { credentialVersion: identity.credentialVersion } });
      return row;
    }),
    create: async (identity, finding) => operation(identity, async (tx, company) => {
      const rows = await tx.select().from(issues).where(owned(identity)).orderBy(desc(issues.createdAt));
      const project = (row: typeof issues.$inferSelect) => ({ id: row.id, identifier: row.identifier,
        title: row.title, description: row.description, status: row.status, createdAt: row.createdAt,
        assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId });
      const prior = rows.find(row => row.originFingerprint === finding.episodeId);
      if (prior) return project(prior);
      const open = rows.find(row => row.status !== 'done' && row.status !== 'cancelled');
      if (open) return project(open);
      const latest = rows[0];
      if (latest) {
        if (Date.now() - latest.createdAt.getTime() < 3600000) throw new Error('hourly cap');
        const [receipt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, identity.companyId), eq(activityLog.actorType, 'service'), eq(activityLog.actorId, identity.id),
          eq(activityLog.action, 'intake_guard.readback'), eq(activityLog.entityId, latest.id)));
        if (!receipt) throw new Error('readback required');
      }
      const counter = company.issueCounter + 1;
      await tx.update(companies).set({ issueCounter: counter }).where(eq(companies.id, company.id));
      const [created] = await tx.insert(issues).values({ companyId: company.id, issueNumber: counter,
        identifier: `${company.issuePrefix}-${counter}`, title: 'mista-intake-stall: fronta roste / producent porušil completed gate',
        description: '<!-- intake-guard: mista-intake-stall -->\n' + JSON.stringify(finding),
        status: 'backlog', priority: 'high', workMode: 'standard', assigneeAgentId: null, assigneeUserId: null,
        parentId: null, executionPolicy: null, originKind: 'intake_guard_service', originId: identity.id,
        originFingerprint: finding.episodeId, createdByUserId: identity.issuerUserId, responsibleUserId: identity.issuerUserId,
      }).returning(projection);
      await tx.insert(activityLog).values({ companyId: identity.companyId, actorType: 'service', actorId: identity.id,
        action: 'intake_guard.created', entityType: 'issue', entityId: created.id,
        details: { issuerUserId: identity.issuerUserId, credentialVersion: identity.credentialVersion } });
      return created;
    }),
    audit: async (identity, outcome) => { await db.insert(activityLog).values({ companyId: identity.companyId,
      actorType: 'service', actorId: identity.id, action: 'intake_guard.' + outcome,
      entityType: 'service_identity', entityId: identity.id,
      details: { issuerUserId: identity.issuerUserId, credentialVersion: identity.credentialVersion } }); },
  };
}
/** Mount before any alternative authentication or provider-side-effect route. */
export function intakeGuardMiddleware(db: Db, store: IntakeGuardStore = intakeGuardStore(db)): RequestHandler {
  return async (req, res, next) => {
    try {
      if (await handleIntakeGuard(req, res, store)) return;
    } catch {
      res.status(503).json({ error: 'Service authorization unavailable' });
      return;
    }
    next();
  };
}

/** Terminal authentication lane: never delegate a pcif bearer to ambient board/agent auth. */
export async function handleIntakeGuard(req: Request, res: Response, store: IntakeGuardStore): Promise<boolean> {
  const header = req.header('authorization') ?? '';
  if (!/^bearer\s+pcif_/i.test(header)) return false;
  req.actor = { type: 'none', source: 'none' };
  let identity: IntakeGuardIdentity;
  try { identity = identitySchema.parse(JSON.parse(process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY ?? 'null')); }
  catch { res.status(401).json({ error: 'Invalid service credential' }); return true; }
  const token = header.replace(/^bearer\s+/i, '');
  const digest = createHash('sha256').update(token).digest();
  const now = Date.now();
  if (!/^pcif_[a-f0-9]{64}$/.test(token) || !timingSafeEqual(digest, Buffer.from(identity.keyHash, 'hex'))
      || now < Date.parse(identity.issuedAt) || now >= Date.parse(identity.expiresAt)
      || Date.parse(identity.expiresAt) - Date.parse(identity.issuedAt) > 30 * 86400000) {
    await store.audit(identity, 'auth_denied'); res.status(401).json({ error: 'Invalid service credential' }); return true;
  }
  if (!(await store.authorize(identity))) {
    await store.audit(identity, 'issuer_denied'); res.status(401).json({ error: 'Invalid service credential' }); return true;
  }
  const listPath = `/api/companies/${identity.companyId}/intake-guard/findings`;
  if (req.method === 'GET' && req.originalUrl === listPath) {
    await store.audit(identity, 'list'); res.json(await store.list(identity)); return true;
  }
  if (req.method === 'POST' && req.originalUrl === listPath) {
    const parsed = findingSchema.safeParse(req.body);
    if (!parsed.success || Math.abs(now - Date.parse(parsed.data.observedAt)) > 900000) {
      await store.audit(identity, 'payload_denied'); res.status(400).json({ error: 'Invalid finding payload' }); return true;
    }
    await store.audit(identity, 'create_requested');
    res.status(201).json(await store.create(identity, parsed.data)); return true;
  }
  const readback = /^\/api\/intake-guard\/findings\/([a-f0-9-]{36})$/.exec(req.originalUrl);
  if (req.method === 'GET' && readback && z.string().uuid().safeParse(readback[1]).success) {
    const actual = await store.read(identity, readback[1]);
    if (!actual) { await store.audit(identity, 'read_denied'); res.status(403).json({ error: 'Service scope denied' }); }
    else res.json(actual);
    return true;
  }
  await store.audit(identity, 'scope_denied'); res.status(403).json({ error: 'Service scope denied' }); return true;
}
