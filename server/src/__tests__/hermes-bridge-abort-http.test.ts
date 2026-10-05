import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { AdapterExecutionContext, AdapterLegacyToolApproval } from '@paperclipai/adapter-utils';
import { execute } from '../../../packages/adapters/hermes/src/gateway/server/execute.js';

async function fixture(mode: 'headers' | 'body', wrongTerminalRun = false, creation: 'normal' | 'pre-cancelled' | 'body' = 'normal', stopMode: 'normal' | 'headers' | 'body' = 'normal') {
  let pending: AdapterLegacyToolApproval | undefined;
  let posts = 0;
  let stops = 0;
  let completed = false;
  let creations = 0;
  const controller = new AbortController();
  const runId = 'abort-provider';
  const requestId = 'abort-request';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/runs') {
      creations++;
      if (creation === 'body') { res.writeHead(200); res.write('{"run_id":'); }
      else res.end(JSON.stringify({ run_id: runId }));
    }
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
      if (stopMode === 'normal') res.end(JSON.stringify({ run_id: wrongTerminalRun ? 'other-provider' : runId, status: 'cancelled' }));
      else if (stopMode === 'body') { res.writeHead(200); res.write('{"run_id":'); }
    } else res.end(JSON.stringify({ run_id: completed && wrongTerminalRun ? 'other-provider' : runId, status: completed ? 'completed' : 'waiting_for_approval' }));
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
  if (creation === 'pre-cancelled') controller.abort();
  const execution = execute(ctx);
  if (creation === 'normal') await expect.poll(() => pending, { timeout: 1000 }).toBeDefined();
  if (creation === 'body') await expect.poll(() => creations, { timeout: 1000 }).toBe(1);
  return { pending: pending!, execution, controller, posts: () => posts, stops: () => stops,
    creations: () => creations,
    complete: () => { completed = true; },
    close: async () => {
      completed = true;
      controller.abort();
      await execution;
      const closed = new Promise<void>(done => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    } };
}
async function observe(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => 'accepted', () => 'rejected'), new Promise<string>(done => { timer = setTimeout(() => done('hung'), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

describe('bounded exact resolver HTTP I/O', () => {
  it('cancellation before creation dispatch sends no provider request', async () => {
    const disposable = await fixture('headers', false, 'pre-cancelled');
    try {
      const result = await disposable.execution;
      expect(result.errorCode).toBe('hermes_gateway_cancelled_before_dispatch');
      expect(disposable.creations()).toBe(0);
      expect(disposable.posts()).toBe(0);
      expect(disposable.stops()).toBe(0);
      expect(result.executionRecovery).toBeUndefined();
    } finally { await disposable.close(); }
  });
  it('cancellation during creation reports unknown provider termination without retry', async () => {
    const disposable = await fixture('headers', false, 'body');
    try {
      disposable.controller.abort();
      const result = await disposable.execution;
      expect(result.errorCode).toBe('hermes_gateway_cancellation_unconfirmed');
      expect(result.errorMeta).toEqual({ createRequestDispatched: true, providerTerminationConfirmed: false });
      expect(result.executionRecovery).toBeUndefined();
      expect(disposable.creations()).toBe(1);
      expect(disposable.posts()).toBe(0);
      expect(disposable.stops()).toBe(0);
    } finally { await disposable.close(); }
  });
  it.each(['headers', 'body'] as const)('rejects never-ending %s within fixed deadline without retry', async mode => {
    const f = await fixture(mode);
    try {
      const startedAt = Date.now();
      expect(await observe(f.pending.resolve('once'), 6000)).toBe('rejected');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4500);
      expect(f.posts()).toBe(1);
      expect(f.stops()).toBe(0);
    }
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
      const result = await f.execution;
      expect(result.errorCode).toBe('hermes_gateway_cancelled');
      expect(result.timedOut).toBe(false);
      expect(result.errorMeta).toEqual({ providerTerminationConfirmed: true });
      expect(result.executionRecovery).toBeUndefined();
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
  it('terminal cleanup fences a previously published resolver', async () => {
    const disposable = await fixture('headers');
    try {
      disposable.complete();
      await disposable.execution;
      expect(await observe(disposable.pending.resolve('once'), 800)).toBe('rejected');
      expect(disposable.posts()).toBe(0);
      expect(disposable.stops()).toBe(0);
    } finally { await disposable.close(); }
  });
  it('does not claim provider termination from another run acknowledgement', async () => {
    const disposable = await fixture('headers', true);
    try {
      disposable.controller.abort();
      const result = await disposable.execution;
      expect(result.errorCode).toBe('hermes_gateway_cancellation_unconfirmed');
      expect(result.errorMeta).toEqual({ providerTerminationConfirmed: false });
      expect(result.executionRecovery).toBeUndefined();
      expect(disposable.stops()).toBe(1);
      expect(disposable.posts()).toBe(0);
    } finally { await disposable.close(); }
  }, 15000);
  it.each(['headers', 'body'] as const)('bounds stalled stop %s and verifies final status without retry', async stopMode => {
    const disposable = await fixture('headers', false, 'normal', stopMode);
    try {
      disposable.controller.abort();
      const result = await disposable.execution;
      expect(result.errorCode).toBe('hermes_gateway_cancelled');
      expect(result.errorMeta).toEqual({ providerTerminationConfirmed: true });
      expect(disposable.stops()).toBe(1);
      expect(disposable.posts()).toBe(0);
      expect(result.executionRecovery).toBeUndefined();
    } finally { await disposable.close(); }
  }, 15000);
});
