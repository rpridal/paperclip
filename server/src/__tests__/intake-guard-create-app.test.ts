import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authUsers, companies, companyMemberships, createDb, issues, activityLog, issueComments, heartbeatRuns } from '@paperclipai/db';
const hooks = vi.hoisted(() => ({ github: vi.fn(async () => ({ offline: true })), cloud: vi.fn(async () => {}) }));
vi.mock('../services/github-operation-credentials.js', () => ({ resolveGitHubOperationCredentials: hooks.github }));
vi.mock('../services/cloud-runtime-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/cloud-runtime-identity.js')>(),
  applyCloudRuntimeIdentityAssertion: hooks.cloud,
}));
import { createApp } from '../app.js';
import { createRuntimeToolsToken } from '../runtime-tools-token.js';
import type { Config } from '../config.js';
import { createBetterAuthInstance, createBetterAuthHandler, resolveBetterAuthSession } from '../auth/better-auth.js';
import type { Request } from 'express';
import { INTAKE_COMPANY_ID } from '../services/intake-guard.js';
import { createStorageService } from '../storage/service.js';
import { createLocalDiskStorageProvider } from '../storage/local-disk-provider.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

// Actual createApp + HTTP + disposable PostgreSQL. Provider boundary is stubbed.
// No production identity is issued; all credentials are ephemeral offline fixtures.
describe('intake guard createApp — OFFLINE', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  let auth: ReturnType<typeof createBetterAuthInstance>;
  let cookie: string;
  const origin = 'http://127.0.0.1:41999';
  const oldBetterSecret = process.env.BETTER_AUTH_SECRET;
  const session = vi.fn((req: Request) => resolveBetterAuthSession(auth, req));
  const token = ['pcif', 'a'.repeat(64)].join('_');
  const oldConfig = process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
  const oldJwt = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const identity = () => ({ id: 'mista-intake-stall', companyId: INTAKE_COMPANY_ID,
    keyHash: createHash('sha256').update(token).digest('hex'), issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), issuerUserId: 'offline-app-issuer', credentialVersion: 'offline-app-v1' });
  const list = `/api/companies/${INTAKE_COMPANY_ID}/intake-guard/findings`;
  const payload = () => ({ type: 'intake_stall', episodeId: randomUUID(), reasons: ['queue_growing_without_completion'],
    observedAt: new Date().toISOString(), queued: 5, lastCompletedAt: null, producerSuspended: true });
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-intake-app-test-');
    db = createDb(temp.connectionString); root = await mkdtemp(join(tmpdir(), 'paperclip-intake-app-test-'));
    const now = new Date();
    await db.insert(authUsers).values({ id: 'offline-app-issuer', name: 'Offline issuer', email: 'offline-app@example.test', createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: INTAKE_COMPANY_ID, name: 'Offline app', issuePrefix: 'IAT' });
    await db.insert(companyMemberships).values({ companyId: INTAKE_COMPANY_ID, principalType: 'user', principalId: 'offline-app-issuer', status: 'active', membershipRole: 'member' });
    process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
    auth = createBetterAuthInstance(db, { deploymentMode: 'authenticated', deploymentExposure: 'private',
      authBaseUrlMode: 'explicit', authPublicBaseUrl: origin, authDisableSignUp: false,
      allowedHostnames: ['127.0.0.1'], port: 41999 } as Config, [origin]);
    // Real Better Auth handler/Drizzle session, no provider or session stub.
    // Keep ephemeral password/cookie in memory and out of HTTP log assertions.
    const signup = await auth.handler(new globalThis.Request(origin + '/api/auth/sign-up/email', {
      method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'offline-board@example.test', name: 'Offline board', password: randomUUID() }),
    }));
    expect(signup.status).toBe(200);
    const user = (await signup.json()).user;
    cookie = signup.headers.getSetCookie().filter(value => value.includes('session_token'))
      .map(value => value.split(';')[0]).join('; ');
    expect(Boolean(cookie)).toBe(true);
    await db.insert(companyMemberships).values({ companyId: INTAKE_COMPANY_ID, principalType: 'user',
      principalId: user.id, status: 'active', membershipRole: 'owner' });
    app = await createApp(db, { uiMode: 'none', serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, 'storage'))),
      deploymentMode: 'authenticated', deploymentExposure: 'private', allowedHostnames: ['127.0.0.1'],
      bindHost: '127.0.0.1', authReady: true, companyDeletionEnabled: false,
      localPluginDir: join(root, 'plugins'), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined }, resolveSession: session,
      betterAuthHandler: createBetterAuthHandler(auth) });
  }, 45000);
  beforeEach(async () => {
    process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify(identity());
    process.env.PAPERCLIP_AGENT_JWT_SECRET = ['offline', 'app', 'jwt', 'fixture'].join('-');
    await db.delete(activityLog); await db.delete(issues); vi.clearAllMocks();
  });
  afterAll(async () => {
    await app?.locals.paperclipShutdown(); await temp?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    if (oldConfig === undefined) delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    else process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = oldConfig;
    if (oldBetterSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = oldBetterSecret;
    if (oldJwt === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldJwt;
  });
  it('executes allowed list/create/owned readback through actual createApp', async () => {
    expect((await request(app).get(list).set('Authorization', 'Bearer ' + token)).body).toEqual([]);
    const created = await request(app).post(list).set('Authorization', 'Bearer ' + token).send(payload());
    expect(created.status).toBe(201);
    const receipt = await request(app).get('/api/intake-guard/findings/' + created.body.id).set('Authorization', 'Bearer ' + token);
    expect(receipt.status).toBe(200); expect(receipt.body).toEqual(created.body);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await db.select().from(activityLog)).filter(row => row.action === 'intake_guard.readback')).toHaveLength(1);
    expect(session).not.toHaveBeenCalled();
  });
  it('denies foreign UUID/company, payload escalation and general mutation routes', async () => {
    const [foreign] = await db.insert(issues).values({ companyId: INTAKE_COMPANY_ID, title: 'Foreign issue' }).returning();
    for (const path of ['/api/intake-guard/findings/' + foreign.id, '/api/intake-guard/findings/' + randomUUID(),
      `/api/companies/${randomUUID()}/intake-guard/findings`, `/api/companies/${INTAKE_COMPANY_ID}/issues`]) {
      expect((await request(app).get(path).set('Authorization', 'Bearer ' + token)).status).toBe(403);
    }
    for (const extra of [{ title: 'foreign-prefix' }, { type: 'foreign' }, { assigneeAgentId: 'foreign' },
      { parentId: foreign.id }, { blockedByIssueIds: [foreign.id] }, { executionPolicy: {} }, { status: 'todo' }, { comment: 'arbitrary' }]) {
      expect((await request(app).post(list).set('Authorization', 'Bearer ' + token).send({ ...payload(), ...extra })).status).toBe(400);
    }
    for (const path of [`/api/issues/${foreign.id}/comments`, `/api/issues/${foreign.id}/checkout`,
      `/api/agents/${randomUUID()}/wakeup`, `/api/companies/${randomUUID()}/intake-guard/findings`]) {
      expect((await request(app).post(path).set('Authorization', 'Bearer ' + token).send(payload())).status).toBe(403);
    }
    expect((await request(app).patch('/api/issues/' + foreign.id).set('Authorization', 'Bearer ' + token)
      .send({ status: 'done', assigneeAgentId: 'foreign' })).status).toBe(403);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(hooks.cloud).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
  });
  it.each(['valid', 'revoked', 'expired', 'malformed'])('keeps a real Better Auth board session terminal for %s pcif', async mode => {
    const boardList = `/api/companies/${INTAKE_COMPANY_ID}/issues`;
    expect((await request(app).get(boardList).set('Host', '127.0.0.1')).status).toBe(401);
    expect((await request(app).get(boardList).set('Host', '127.0.0.1').set('Cookie', cookie)).status).toBe(200);
    expect(session).toHaveBeenCalled();
    vi.clearAllMocks();
    if (mode === 'revoked') delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    if (mode === 'expired') process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify({ ...identity(), expiresAt: new Date(Date.now() - 1).toISOString() });
    const bearer = 'Bearer ' + (mode === 'malformed' ? 'pcif_malformed' : token);
    const expected = mode === 'valid' ? 403 : 401;
    const mixed = (method: 'get' | 'post' | 'patch', path: string) => request(app)[method](path)
      .set('Host', '127.0.0.1').set('Cookie', cookie).set('Authorization', bearer).set('Origin', origin);
    const created = await mixed('post', list).send(payload());
    expect(created.status).toBe(mode === 'valid' ? 201 : 401);
    expect((await mixed('get', list)).status).toBe(mode === 'valid' ? 200 : 401);
    const uuid = mode === 'valid' ? created.body.id : randomUUID();
    expect((await mixed('get', '/api/intake-guard/findings/' + uuid)).status).toBe(mode === 'valid' ? 200 : 401);
    for (const path of [boardList, '/api/issues/' + uuid, `/api/companies/${randomUUID()}/intake-guard/findings`]) {
      expect((await mixed('get', path)).status).toBe(expected);
    }
    for (const path of [boardList, '/api/issues/' + uuid + '/comments', '/api/agents/' + randomUUID() + '/wakeup',
      '/api/auth/sign-in/email', '/api/routine-triggers/public/aaaaaaaaaaaaaaaaaaaaaaaa/fire', '/api/chat-webhooks/slack']) {
      expect((await mixed('post', path).send({ title: 'Disallowed', body: 'Disallowed' })).status).toBe(expected);
    }
    expect((await mixed('patch', '/api/issues/' + uuid).send({ status: 'done', assigneeUserId: 'foreign' })).status).toBe(expected);
    expect(session).not.toHaveBeenCalled(); expect(hooks.cloud).not.toHaveBeenCalled(); expect(hooks.github).not.toHaveBeenCalled();
    expect(await db.select().from(issues)).toHaveLength(mode === 'valid' ? 1 : 0);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
  it.each(['valid', 'revoked', 'expired', 'malformed'])('blocks mixed runtime/cloud/cookie capabilities for %s bearer', async mode => {
    if (mode === 'revoked') delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    if (mode === 'expired') process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify({ ...identity(), expiresAt: new Date(Date.now() - 1).toISOString() });
    const cap = createRuntimeToolsToken({ agentId: 'offline', companyId: INTAKE_COMPANY_ID, runId: 'offline', responsibleUserId: 'offline', scope: 'github_credentials' })!;
    const bearer = 'Bearer ' + (mode === 'malformed' ? 'pcif_malformed' : token);
    // Each alternative must be valid for its own endpoint; a cookie would block
    // runtime capabilities before the provider and mask the early-lane defect.
    const runtime = await request(app).post('/runtime-tools/github/credentials')
      .set('Host', '127.0.0.1').set('Authorization', bearer).set('x-paperclip-github-capability', cap.token).send({});
    expect(runtime.status).toBe(mode === 'valid' ? 403 : 401);
    const cloud = await request(app).get('/api/health').set('Host', '127.0.0.1')
      .set('Authorization', bearer).set('x-paperclip-cloud-runtime-identity', 'offline-assertion');
    expect(cloud.status).toBe(mode === 'valid' ? 403 : 401);
    for (const path of ['/api/routine-triggers/public/aaaaaaaaaaaaaaaaaaaaaaaa/fire', '/api/chat-webhooks/slack', '/api/auth/sign-in/email']) {
      const response = await request(app).post(path).set('Authorization', bearer)
        .set('Cookie', 'offline=ambient').send({ assigneeAgentId: 'foreign' });
      expect(response.status).toBe(mode === 'valid' ? 403 : 401);
    }
    expect(hooks.github).not.toHaveBeenCalled(); expect(hooks.cloud).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
});
