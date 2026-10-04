import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, authUsers, companies, companyMemberships, createDb, issues } from '@paperclipai/db';
import { eq, sql } from 'drizzle-orm';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { INTAKE_COMPANY_ID, intakeGuardStore, type IntakeGuardIdentity, type IntakeFinding } from '../services/intake-guard.js';

// Real disposable PostgreSQL; no production credentials or live enforcement.
describe('intake guard store — OFFLINE real PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let store: ReturnType<typeof intakeGuardStore>;
  const identity: IntakeGuardIdentity = {
    id: 'mista-intake-stall', companyId: INTAKE_COMPANY_ID, keyHash: '0'.repeat(64),
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    issuerUserId: 'offline-issuer', credentialVersion: 'offline-v1',
  };
  const finding = (): IntakeFinding => ({ type: 'intake_stall', episodeId: randomUUID(),
    reasons: ['queue_growing_without_completion'], observedAt: new Date().toISOString(),
    queued: 5, lastCompletedAt: null, producerSuspended: true });
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-intake-guard-test-');
    db = createDb(temp.connectionString); store = intakeGuardStore(db);
    const now = new Date();
    await db.insert(authUsers).values({ id: identity.issuerUserId, name: 'Offline issuer',
      email: 'offline-issuer@example.test', createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: INTAKE_COMPANY_ID, name: 'Offline intake', issuePrefix: 'IGT' });
    await db.insert(companyMemberships).values({ companyId: INTAKE_COMPANY_ID, principalType: 'user',
      principalId: identity.issuerUserId, status: 'active', membershipRole: 'member' });
  }, 45000);
  const originalConfig = process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
  beforeEach(async () => {
    process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify(identity);
    await db.delete(activityLog); await db.delete(issues);
    await db.update(companyMemberships).set({ status: 'active', membershipRole: 'member' });
  });
  afterAll(async () => {
    if (originalConfig === undefined) delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    else process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = originalConfig;
    await temp?.cleanup();
  });
  it.each(['revoke', 'rotate', 'membership'])('fences a create waiting on company lock after %s', async change => {
    expect(await store.authorize(identity)).toBe(true);
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, INTAKE_COMPANY_ID)).for('update');
      locked(); await gate;
    });
    await ready;
    const pending = store.create(identity, finding()).then(row => ({ row, error: null }), error => ({ row: null, error }));
    try {
      // Observe PostgreSQL itself, not a guessed delay, before changing authority.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%"companies"%'`);
        if (Number(result[0]?.n) > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      if (change === 'revoke') delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
      if (change === 'rotate') process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify({ ...identity, credentialVersion: 'offline-v2' });
      if (change === 'membership') await db.update(companyMemberships).set({ status: 'inactive' });
    } finally { release(); await blocker; }
    const result = await pending;
    expect(result.error).toBeTruthy(); expect(result.row).toBeNull();
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
  it('serializes simultaneous replicas and persists one unassigned owned finding', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.create(identity, finding())));
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    for (const row of results) {
      expect(Object.keys(row).sort()).toEqual(['id', 'identifier', 'title', 'description', 'status',
        'createdAt', 'assigneeAgentId', 'assigneeUserId'].sort());
    }
    const rows = await store.list(identity) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'backlog', assigneeAgentId: null, assigneeUserId: null });
    expect(rows[0].title.startsWith('mista-intake-stall:')).toBe(true);
    expect(await store.read(identity, randomUUID())).toBeNull();
    expect(await store.read(identity, rows[0].id)).toMatchObject({ id: rows[0].id });
  });
  it('includes closed episodes and refuses a new episode without readback', async () => {
    const first = await store.create(identity, finding());
    await db.update(issues).set({ status: 'done', createdAt: new Date(Date.now() - 7200000) }).where(eq(issues.id, first.id));
    expect((await store.list(identity) as any[])[0].status).toBe('done');
    await expect(store.create(identity, finding())).rejects.toThrow('readback required');
    await store.read(identity, first.id);
    const second = await store.create(identity, finding()); expect(second.id).not.toBe(first.id);
  });
  it('counts closed episodes against the rolling hourly cap after readback', async () => {
    const first = await store.create(identity, finding());
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, first.id));
    await store.read(identity, first.id);
    await expect(store.create(identity, finding())).rejects.toThrow('hourly cap');
  });
  it('keeps episode retry idempotent after close and credential rotation', async () => {
    const input = finding(); const first = await store.create(identity, input);
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, first.id));
    const rotated = { ...identity, credentialVersion: 'offline-v2' };
    process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify(rotated);
    expect((await store.create(rotated, input)).id).toBe(first.id);
    expect(await store.read(rotated, first.id)).toMatchObject({ id: first.id });
  });
  it('excludes foreign origin and cross-company issues from list/readback', async () => {
    const other = randomUUID();
    await db.insert(companies).values({ id: other, name: 'Other offline', issuePrefix: 'IGO' });
    const [foreign, cross] = await db.insert(issues).values([
      { companyId: INTAKE_COMPANY_ID, title: 'mista-intake-stall: forged title', originKind: 'other', originId: identity.id },
      { companyId: other, title: 'mista-intake-stall: cross company', originKind: 'intake_guard_service', originId: identity.id },
    ]).returning();
    expect(await store.list(identity)).toEqual([]);
    expect(await store.read(identity, foreign.id)).toBeNull(); expect(await store.read(identity, cross.id)).toBeNull();
  });
  it('authorizes only a current active non-viewer issuer membership', async () => {
    expect(await store.authorize(identity)).toBe(true);
    await db.update(companyMemberships).set({ membershipRole: 'viewer' }); expect(await store.authorize(identity)).toBe(false);
    await db.update(companyMemberships).set({ membershipRole: 'member', status: 'inactive' });
    expect(await store.authorize(identity)).toBe(false);
    expect(await store.authorize({ ...identity, issuerUserId: 'foreign' })).toBe(false);
  });
  it.each(['owner', 'admin', 'operator'])('accepts an active %s operator issuer', async role => {
    await db.update(companyMemberships).set({ membershipRole: role });
    expect(await store.authorize(identity)).toBe(true);
  });
  it('rolls back a readback receipt failure and preserves the cap across store reconstruction', async () => {
    const row = await store.create(identity, finding());
    await db.update(issues).set({ status: 'done', createdAt: new Date(Date.now() - 7200000) }).where(eq(issues.id, row.id));
    await db.execute(sql`create function intake_test_reject_readback() returns trigger language plpgsql as $$
      begin if NEW.action = 'intake_guard.readback' then raise exception 'offline receipt sink unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger intake_test_readback before insert on activity_log
      for each row execute function intake_test_reject_readback()`);
    try { await expect(store.read(identity, row.id)).rejects.toThrow(); }
    finally {
      await db.execute(sql`drop trigger intake_test_readback on activity_log`);
      await db.execute(sql`drop function intake_test_reject_readback()`);
    }
    const rebuilt = intakeGuardStore(createDb(temp.connectionString));
    await expect(rebuilt.create(identity, finding())).rejects.toThrow('readback required');
    expect((await db.select().from(activityLog)).filter(log => log.action === 'intake_guard.readback')).toHaveLength(0);
    expect(await rebuilt.read(identity, row.id)).toMatchObject({ id: row.id });
    expect((await rebuilt.create(identity, finding())).id).not.toBe(row.id);
  });
  it('audits only safe lifecycle metadata and finding UUIDs', async () => {
    const row = await store.create(identity, finding()); await store.read(identity, row.id);
    await store.audit(identity, 'scope_denied');
    const logs = await db.select().from(activityLog);
    expect(logs.map(log => log.action).sort()).toEqual(['intake_guard.created', 'intake_guard.readback', 'intake_guard.scope_denied']);
    for (const log of logs) {
      expect(log.actorType).toBe('service'); expect(log.actorId).toBe(identity.id);
      expect(Object.keys(log.details ?? {}).sort()).toEqual(log.action === 'intake_guard.readback'
        ? ['credentialVersion'] : ['credentialVersion', 'issuerUserId']);
    }
  });
});
