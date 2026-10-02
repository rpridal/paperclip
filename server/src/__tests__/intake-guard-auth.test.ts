import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';

const companyId = 'b954377a-979e-461a-b568-44f9104f0512';
const oldConfig = process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
afterEach(() => { if (oldConfig === undefined) delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY; else process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = oldConfig; });
function fixture() {
  const token = 'pcif_' + randomBytes(32).toString('hex');
  process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify({
    id: 'mista-intake-stall', companyId, keyHash: createHash('sha256').update(token).digest('hex'),
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(),
    issuerUserId: 'offline-operator', credentialVersion: 'offline-v1',
  });
  const store = { authorize: async () => true, list: async () => [], audit: async () => {}, read: async () => null, create: async () => ({ id: 'd1b6c3a4-6038-4bb7-bc26-3934d59071ff' }) };
  const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as any;
  const app = express(); app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: 'authenticated', intakeGuardStore: store } as any));
  app.use((_req, res) => res.status(599).json({ escaped: true })); app.use(errorHandler);
  return { app, token, store };
}
describe('intake guard service identity — OFFLINE HTTP/auth tests, stub store', () => {
  it('allows only dedicated finding list with a distinct service bearer', async () => {
    const { app, token } = fixture();
    const res = await request(app).get(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200); expect(res.body).toEqual([]);
  });
  it('creates and reads back its finding using a strict structured payload', async () => {
    const { app, token, store } = fixture();
    const payload = { type: 'intake_stall', episodeId: 'ecb4be6b-96a6-49bb-90c2-bdfe280b690a',
      reasons: ['queue_growing_without_completion'], observedAt: new Date().toISOString(), queued: 21,
      lastCompletedAt: null, producerSuspended: true };
    const created = await request(app).post(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`).send(payload);
    expect(created.status).toBe(201);
    store.read = async () => ({ id: created.body.id }) as any;
    const actual = await request(app).get(`/api/intake-guard/findings/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(actual.status).toBe(200); expect(actual.body.id).toBe(created.body.id);
  });
  it.each([
    ['get', '/api/companies/00000000-0000-4000-8000-000000000000/intake-guard/findings'],
    ['post', '/api/companies/00000000-0000-4000-8000-000000000000/intake-guard/findings'],
    ['get', `/api/companies/${companyId}/issues`], ['post', `/api/companies/${companyId}/issues`],
    ['get', '/api/issues/d1b6c3a4-6038-4bb7-bc26-3934d59071ff'],
    ['patch', '/api/issues/d1b6c3a4-6038-4bb7-bc26-3934d59071ff'],
    ['post', '/api/issues/d1b6c3a4-6038-4bb7-bc26-3934d59071ff/comments'],
    ['post', '/api/agents/5932b2f8-24b8-4828-a4b7-6d350ba9b8d3/wakeup'],
    ['post', '/api/routine-triggers/public/aaaaaaaaaaaaaaaaaaaaaaaa/fire'],
    ['get', `/api/companies/${companyId}/intake-guard/findings?status=done`],
  ])('denies %s %s without falling through', async (method, path) => {
    const { app, token } = fixture();
    const res = await (request(app) as any)[method](path).set('Authorization', `Bearer ${token}`).send({ assigneeAgentId: 'other' });
    expect(res.status).toBe(403); expect(res.body.escaped).toBeUndefined();
  });
  it('denies another issue UUID on dedicated readback', async () => {
    const { app, token } = fixture();
    const res = await request(app).get('/api/intake-guard/findings/d1b6c3a4-6038-4bb7-bc26-3934d59071ff').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
  it.each(['title', 'description', 'assigneeAgentId', 'assigneeUserId', 'parentId', 'blockedByIssueIds', 'executionPolicy', 'status', 'comment'])('denies extra payload field %s', async field => {
    const { app, token } = fixture();
    const res = await request(app).post(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`).send({
      type: 'intake_stall', episodeId: 'ecb4be6b-96a6-49bb-90c2-bdfe280b690a', reasons: ['queue_growing_without_completion'],
      observedAt: new Date().toISOString(), queued: 21, lastCompletedAt: null, producerSuspended: true, [field]: 'foreign',
    });
    expect(res.status).toBe(400);
  });
  it.each(['expired', 'future', 'overlong', 'revoked', 'rotated', 'wrong-company'])('fails closed for %s identity configuration', async mode => {
    const { app, token } = fixture();
    const config = JSON.parse(process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY!);
    const now = Date.now();
    if (mode === 'expired') { config.issuedAt = new Date(now - 60000).toISOString(); config.expiresAt = new Date(now - 1000).toISOString(); }
    if (mode === 'future') config.issuedAt = new Date(now + 10000).toISOString();
    if (mode === 'overlong') config.expiresAt = new Date(now + 31 * 24 * 60 * 60 * 1000).toISOString();
    if (mode === 'rotated') config.keyHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    if (mode === 'wrong-company') config.companyId = '00000000-0000-4000-8000-000000000000';
    process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify(config);
    if (mode === 'revoked') delete process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY;
    const res = await request(app).get(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401); expect(res.body.escaped).toBeUndefined();
    expect(JSON.stringify(res.body).includes(token)).toBe(false);
  });
  it('denies a foreign finding type', async () => {
    const { app, token } = fixture();
    const res = await request(app).post(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`).send({
      type: 'foreign_finding', episodeId: 'ecb4be6b-96a6-49bb-90c2-bdfe280b690a', reasons: ['queue_growing_without_completion'],
      observedAt: new Date().toISOString(), queued: 21, lastCompletedAt: null, producerSuspended: true,
    });
    expect(res.status).toBe(400);
  });
  it('denies a revoked issuer membership before any finding access', async () => {
    const { app, token, store } = fixture();
    Object.assign(store, { authorize: async () => false });
    const res = await request(app).get(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
  it('fails closed on audit failure without returning credential material', async () => {
    const { app, token, store } = fixture(); store.audit = async () => { throw new Error(token); };
    const res = await request(app).get(`/api/companies/${companyId}/intake-guard/findings`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503); expect(JSON.stringify(res.body).includes(token)).toBe(false);
  });
});
