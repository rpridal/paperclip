import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authUsers, companies, companyMemberships, createDb, issues, activityLog } from '@paperclipai/db';
import { eq, sql } from 'drizzle-orm';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { INTAKE_COMPANY_ID } from '../services/intake-guard.js';

// Actual createApp server processes and separate contract-sampler processes.
// Disposable PostgreSQL remains alive. No live server, production sampler or identity.
describe('intake guard process restart — OFFLINE', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const children = new Set<ChildProcess>();
  const token = ['pcif', 'b'.repeat(64)].join('_');
  const identity = { id: 'mista-intake-stall', companyId: INTAKE_COMPANY_ID,
    keyHash: createHash('sha256').update(token).digest('hex'), issuerUserId: 'offline-process-issuer',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
    credentialVersion: 'offline-process-v1' };
  async function launch(input: object) {
    const child = fork(fileURLToPath(new URL('./helpers/intake-guard-process.ts', import.meta.url)), [], {
      // Resolve from this server package, not the invoking root/workspace cwd.
      execArgv: ['--import', import.meta.resolve('tsx')],
      // Do not inherit any Paperclip/Forgejo/board credentials from this heartbeat.
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.add(child);
    const message = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('offline process readiness deadline')), 20000);
      child.once('message', result => { clearTimeout(timer); resolve(result); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('offline child failed')); });
    });
    child.send(input);
    const result = await message;
    expect(result.failed).not.toBe(true);
    return { child, result };
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  async function server() {
    const result = await launch({ role: 'server', identity, root, connectionString: temp.connectionString });
    expect(result.result.ready).toBe(true);
    return { child: result.child, pid: result.result.pid, base: 'http://127.0.0.1:' + result.result.port };
  }
  async function sample(base: string, statePath: string, action = 'publish') {
    const { child, result } = await launch({ role: 'sampler', base, token, companyId: INTAKE_COMPANY_ID, statePath, action });
    if (child.exitCode === null) await once(child, 'exit');
    expect(child.exitCode).toBe(0);
    return result;
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paperclip-intake-process-'));
    temp = await startEmbeddedPostgresTestDatabase('paperclip-intake-process-');
    db = createDb(temp.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({ id: identity.issuerUserId, name: 'Offline issuer', email: 'process@example.test', createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: INTAKE_COMPANY_ID, name: 'Offline process', issuePrefix: 'IPT' });
    await db.insert(companyMemberships).values({ companyId: INTAKE_COMPANY_ID, principalType: 'user', principalId: identity.issuerUserId, status: 'active', membershipRole: 'operator' });
  }, 45000);
  afterAll(async () => {
    for (const child of children) await stop(child);
    await temp?.cleanup(); if (root) await rm(root, { recursive: true, force: true });
  });
  it('keeps retry, readback rollback, durable receipt and rolling cap across killed server/sampler processes', async () => {
    const statePath = join(root, 'sampler-state.json');
    const firstServer = await server();
    const first = await sample(firstServer.base, statePath);
    expect(first.status).toBe(201);
    await stop(firstServer.child);
    const secondServer = await server(); expect(secondServer.pid).not.toBe(firstServer.pid);
    const retry = await sample(secondServer.base, statePath);
    expect(retry.pid).not.toBe(first.pid); expect(retry.id).toBe(first.id);
    expect(await db.select().from(issues)).toHaveLength(1);
    // Closed/recent finding is still capped after a successful readback and restart.
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, first.id));
    expect((await sample(secondServer.base, statePath, 'read')).status).toBe(200);
    const freshPath = join(root, 'fresh-state.json');
    await writeFile(freshPath, JSON.stringify({ episodeId: randomUUID() }));
    expect((await sample(secondServer.base, freshPath)).status).toBe(503);
    // Remove receipt in the disposable fixture, age past cap, and force receipt sink failure.
    await db.delete(activityLog).where(eq(activityLog.action, 'intake_guard.readback'));
    await db.update(issues).set({ createdAt: new Date(Date.now() - 7200000) }).where(eq(issues.id, first.id));
    await db.execute(sql`create function intake_process_reject() returns trigger language plpgsql as $$
      begin if NEW.action = 'intake_guard.readback' then raise exception 'offline sink failure'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger intake_process_receipt before insert on activity_log for each row execute function intake_process_reject()`);
    expect((await sample(secondServer.base, statePath, 'read')).status).toBe(503);
    await stop(secondServer.child);
    await db.execute(sql`drop trigger intake_process_receipt on activity_log`);
    await db.execute(sql`drop function intake_process_reject()`);
    const thirdServer = await server(); expect(thirdServer.pid).not.toBe(secondServer.pid);
    expect((await sample(thirdServer.base, freshPath)).status).toBe(503);
    expect((await db.select().from(activityLog)).filter(row => row.action === 'intake_guard.readback')).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(1);
    const receipt = await sample(thirdServer.base, statePath, 'read'); expect(receipt.status).toBe(200);
    await stop(thirdServer.child);
    const fourthServer = await server();
    expect(new Set([firstServer.pid, secondServer.pid, thirdServer.pid, fourthServer.pid]).size).toBe(4);
    const next = await sample(fourthServer.base, freshPath); expect(next.status).toBe(201); expect(next.id).not.toBe(first.id);
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(await readFile(statePath, 'utf8')).not.toContain(token);
    expect(await readFile(freshPath, 'utf8')).not.toContain(token);
    await stop(fourthServer.child);
  }, 45000);
});
