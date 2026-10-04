import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ github: vi.fn(async () => ({ offline: true })), cloud: vi.fn(async () => {}) }));
vi.mock('../services/github-operation-credentials.js', () => ({ resolveGitHubOperationCredentials: hooks.github }));
vi.mock('../services/cloud-runtime-identity.js', () => ({ CLOUD_RUNTIME_IDENTITY_HEADER: 'x-paperclip-cloud-runtime-identity', applyCloudRuntimeIdentityAssertion: hooks.cloud }));
import { intakeGuardMiddleware } from '../services/intake-guard.js';
import { actorMiddleware } from '../middleware/auth.js';
import { cloudRuntimeIdentityMiddleware } from '../middleware/cloud-runtime-identity.js';
import { runtimeConnectionIntentRoutes } from '../routes/connection-intents.js';
import { createRuntimeToolsToken } from '../runtime-tools-token.js';
const keys = ['PAPERCLIP_INTAKE_GUARD_IDENTITY', 'PAPERCLIP_AGENT_JWT_SECRET'];
const old = keys.map(k => process.env[k]);
afterEach(() => { keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }); vi.clearAllMocks(); });
const companyId = 'b954377a-979e-461a-b568-44f9104f0512';
const listPath = `/api/companies/${companyId}/intake-guard/findings`;

describe('early admission — OFFLINE real middleware composition, stub provider/store, not createApp', () => {
  it.each(['valid', 'revoked', 'expired', 'malformed'])('blocks alternate runtime/cloud/cookie auth for %s pcif', async mode => {
    const token = 'pcif_' + randomBytes(32).toString('hex');
    const now = Date.now();
    process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify({ id: 'mista-intake-stall', companyId,
      keyHash: createHash('sha256').update(token).digest('hex'), issuedAt: new Date(now - 60000).toISOString(),
      expiresAt: new Date(now + (mode === 'expired' ? -1000 : 60000)).toISOString(), issuerUserId: 'offline', credentialVersion: 'offline' });
    if (mode === 'revoked') delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString('hex');
    const cap = createRuntimeToolsToken({ agentId: 'offline', companyId, runId: 'offline', responsibleUserId: 'offline', scope: 'github_credentials' })!;
    const session = vi.fn(async () => null);
    const store = { authorize: async () => true, audit: async () => {}, list: async () => [], read: async () => null, create: async () => ({ id: 'offline' }) };
    const app = express(); app.use(express.json()); app.use(intakeGuardMiddleware({} as any, store));
    app.use(cloudRuntimeIdentityMiddleware({} as any)); app.use(runtimeConnectionIntentRoutes({} as any));
    app.use(actorMiddleware({} as any, { deploymentMode: 'authenticated', resolveSession: session }));
    app.use((_req, res) => res.status(599).end());
    for (const path of ['/runtime-tools/github/credentials', '/api/health', '/api/routine-triggers/public/aaaaaaaaaaaaaaaaaaaaaaaa/fire']) {
      const res = await request(app).post(path).set('Authorization', 'Bearer ' + (mode === 'malformed' ? 'pcif_malformed' : token))
        .set('x-paperclip-github-capability', cap.token).set('x-paperclip-cloud-runtime-identity', 'offline-assertion')
        .set('Cookie', 'offline=ambient').send({ assigneeAgentId: 'foreign' });
      expect(res.status).toBe(mode === 'valid' ? 403 : 401);
    }
    expect(hooks.github).not.toHaveBeenCalled(); expect(hooks.cloud).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    if (mode === 'valid') {
      const res = await request(app).get(listPath).set('Authorization', 'Bearer ' + token).set('x-paperclip-cloud-runtime-identity', 'offline-assertion');
      expect(res.status).toBe(200); expect(res.body).toEqual([]); expect(hooks.cloud).not.toHaveBeenCalled();
    }
  });
});
