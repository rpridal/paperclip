import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { AdapterExecutionContext, AdapterLegacyToolApproval } from '@paperclipai/adapter-utils';
import { execute } from '../../../packages/adapters/hermes/src/gateway/server/execute.js';

async function fixture(mode: string) {
  let pending: AdapterLegacyToolApproval | undefined;
  let received = 0;
  let posts = 0;
  let completed = false;
  const expected = 'provider-fixture';
  const approval = { event: 'approval.request', run_id: expected, request_id: 'fixture-request' };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/runs') res.end(JSON.stringify({ run_id: expected }));
    else if (req.url?.endsWith('/events')) {
      res.setHeader('Content-Type', 'text/event-stream');
      const data = mode === 'sse-mismatch' ? { ...approval, run_id: 'wrong-provider' } : approval;
      if (mode.startsWith('poll')) res.writeHead(503).end();
      else res.end(`event: approval.request\ndata: ${JSON.stringify(data)}\n\n`);
    } else if (req.url?.endsWith('/approval')) {
      posts++;
      let body = ''; for await (const chunk of req) body += chunk;
      const choice = JSON.parse(body).choice;
      completed = true;
      const ack = { run_id: expected, request_id: approval.request_id, choice, resolved: 1 };
      if (mode === 'ack-run') ack.run_id = 'wrong-provider';
      if (mode === 'ack-request') ack.request_id = 'wrong-request';
      if (mode === 'ack-choice') ack.choice = 'deny';
      if (mode === 'ack-zero') ack.resolved = 0;
      res.end(JSON.stringify(ack));
    } else {
      const data = { run_id: mode === 'poll-outer' ? 'wrong-provider' : expected, status: completed ? 'completed' : 'waiting_for_approval', approval: mode === 'poll-inner' || mode === 'sse-mismatch' ? { ...approval, run_id: 'wrong-provider' } : approval };
      // Mismatch fixtures terminate after enough time for one polling attempt.
      if (mode.includes('mismatch') || mode.startsWith('poll')) data.status = 'completed';
      res.end(JSON.stringify(data));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const config = { apiBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only', timeoutSec: 2, pollIntervalMs: 250, eventReconnectMs: 250 };
  const ctx: AdapterExecutionContext = {
    runId: 'paperclip-fixture', agent: { id: 'fixture', companyId: 'fixture', name: 'fixture', adapterType: 'hermes_gateway', adapterConfig: config },
    config, context: {}, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async () => {}, onLegacyToolApproval: async value => { pending = value; received++; },
  };
  const execution = execute(ctx);
  return { execution, pending: () => pending, received: () => received, posts: () => posts,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe('provider approval correlation over disposable HTTP', () => {
  it.each(['sse-mismatch', 'poll-inner', 'poll-outer'])('rejects explicit provider mismatch: %s', async mode => {
    const f = await fixture(mode);
    try { await f.execution; expect(f.received()).toBe(0); expect(f.posts()).toBe(0); }
    finally { await f.close(); }
  });
  it.each(['ack-run', 'ack-request', 'ack-choice', 'ack-zero'])('rejects invalid 2xx ACK: %s', async mode => {
    const f = await fixture(mode);
    try {
      await expect.poll(f.pending, { timeout: 1000 }).toBeDefined();
      await expect(f.pending()!.resolve('once')).rejects.toThrow(/acknowledgement/i);
      expect(f.posts()).toBe(1);
      await f.execution;
    } finally { await f.close(); }
  });
});
