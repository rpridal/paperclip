import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createHttpLogger } from '../middleware/logger.js';
import { errorHandler } from '../middleware/error-handler.js';

describe('intake lane logging — OFFLINE real HTTP log sink', () => {
  it.each([400, 401, 403, 503])('omits arbitrary input and error material at %s on a foreign path', async status => {
    const chunks: string[] = [];
    const token = 'pcif_' + randomBytes(32).toString('hex');
    const canary = 'private-intake-prose-canary';
    const app = express();
    app.use(createHttpLogger(pino({}, new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } }))));
    app.use(express.json());
    app.use((req, res) => {
      (res as any).__errorContext = { error: { message: canary }, reqBody: req.body, reqParams: { prose: canary } };
      (res as any).err = new Error(canary);
      res.set('x-private-diagnostic', canary).status(status).end();
    });
    const response = await request(app).post('/foreign/' + canary + '?input=' + canary)
      .set('Authorization', 'Bearer ' + token).set('x-private-input', canary).send({ description: canary });
    expect(response.status).toBe(status);
    const output = chunks.join('');
    const row = JSON.parse(output.trim());
    expect(row.reqBody).toBeUndefined();
    expect(row.reqParams).toBeUndefined();
    expect(row.req.headers).toBeUndefined();
    expect(row.res.headers).toBeUndefined();
    expect(row.req.url).toBe('/intake-guard/:scoped-request');
    expect(output.includes(canary)).toBe(false);
    expect(output.includes(token)).toBe(false);
  });
  it('omits malformed JSON before intake authentication can run', async () => {
    const chunks: string[] = [];
    const app = express();
    app.use(createHttpLogger(pino({}, new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } }))));
    app.use(express.json()); app.use(errorHandler);
    const canary = 'private-malformed-intake-canary';
    const response = await request(app).post('/api/companies/foreign/intake-guard/findings')
      .set('Authorization', 'Bearer pcif_malformed').set('Content-Type', 'application/json').send('{"description":"' + canary);
    expect(response.status).toBe(400);
    expect(chunks.join('').includes(canary)).toBe(false);
    expect(chunks.join('').includes('pcif_malformed')).toBe(false);
  });
});
