import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { AdapterExecutionContext, AdapterLegacyToolApproval } from '@paperclipai/adapter-utils';
import { execute } from '../../../packages/adapters/hermes/src/gateway/server/execute.js';

async function fixture(mode: 'headers' | 'body') {
  let pending: AdapterLegacyToolApproval | undefined;
  let posts = 0;
  let stops = 0;
  let completed = false;
  const controller = new AbortController();
  const runId = 'abort-provider';
  const requestId = 'abort-request';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/runs') res.end(JSON.stringify({ run_id: runId }));
    else if (req.url?.endsWith('/events')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`event: approval.request\ndata: ${JSON.stringify({ event: 'approval.request', run_id: runId, request_id: requestId })}\n\n`);
    } else if (req.url?.endsWith('/approval')) {
      for await (const _chunk of req) { /* consume without executing anything */ }
      posts++;
      if (mode === 'body') { res.writeHead(200); res.write('{"run_id":'); }
      // Deliberately never sends headers or finishes body. No sentinel execution.
    } else if (req.url?.endsWith('/stop')) {
      stops++; completed = true;
      res.end(JSON.stringify({ run_id: runId, status: 'cancelled' }));
    } else res.end(JSON.stringify({ run_id: runId, status: completed ? 'completed' : 'waiting_for_approval' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('port');
  const config = { apiBaseUrl: `http://127.0.0.1:${addr.port}`, apiKey: 'disposable-test-key', timeoutSec: 20, pollIntervalMs: 250, eventReconnectMs: 250 };
  const ctx: AdapterExecutionContext = {
    signal: controller.signal,
    runId: 'abort-paperclip', agent: { id: 'fixture', companyId: 'fixture', name: 'fixture', adapterType: 'hermes_gateway', adapterConfig: config },
    config, context: {}, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async () => {}, onLegacyToolApproval: async value => { pending = value; },
  };
  const execution = execute(ctx);
  await expect.poll(() => pending, { timeout: 1000 }).toBeDefined();
  return { pending: pending!, execution, controller, posts: () => posts, stops: () => stops,
    close: async () => { completed = true; server.closeAllConnections(); await execution; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
async function observe(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => 'accepted', () => 'rejected'), new Promise<string>(done => { timer = setTimeout(() => done('hung'), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

describe('bounded exact resolver HTTP I/O', () => {
  it.each(['headers', 'body'] as const)('rejects never-ending %s within fixed deadline without retry', async mode => {
    const f = await fixture(mode);
    try { expect(await observe(f.pending.resolve('once'), 6000)).toBe('rejected'); expect(f.posts()).toBe(1); }
    finally { await f.close(); }
  }, 10000);
  it('run cancellation aborts an in-flight body and requests provider stop', async () => {
    const f = await fixture('body');
    try {
      const resolution = f.pending.resolve('once');
      await expect.poll(f.posts).toBe(1);
      f.controller.abort();
      expect(await observe(resolution, 800)).toBe('rejected');
      await expect.poll(f.stops, { timeout: 1000 }).toBe(1);
      await f.execution;
      expect(f.posts()).toBe(1); // In-flight POST is ambiguous, not rolled back.
    } finally { await f.close(); }
  });
  it('cancel before resolve sends no provider consent POST', async () => {
    const f = await fixture('headers');
    try {
      f.controller.abort();
      expect(await observe(f.pending.resolve('once'), 800)).toBe('rejected');
      expect(f.posts()).toBe(0);
      await expect.poll(f.stops, { timeout: 1000 }).toBe(1);
    } finally { await f.close(); }
  });
});
