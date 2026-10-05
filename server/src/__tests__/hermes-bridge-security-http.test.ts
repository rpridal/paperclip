import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { execute } from '../../../packages/adapters/hermes/src/gateway/server/execute.js';

describe('Hermes bridge security over disposable HTTP', () => {
  it('redacts adapter-private credentials recursively in logs and published events', async () => {
    // Deliberately not bearer-shaped: only the exact adapter redactor knows these.
    const credential = 'fixture-private-value';
    const headerValue = 'fixture-header-value';
    const logs: string[] = [];
    const events: unknown[] = [];
    const server = createServer((_req, res) => {
      if (_req.url === '/v1/runs') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ run_id: 'security-run' }));
      } else if (_req.url?.endsWith('/events')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`event: message.delta\ndata: ${JSON.stringify({ delta: credential, message: headerValue, nested: { innocent: [credential, headerValue] } })}\n\nevent: run.completed\ndata: {"status":"completed","output":"done"}\n\n`);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'completed' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const config = { apiBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: credential, headers: { 'X-Fixture': headerValue }, timeoutSec: 2 };
    const ctx: AdapterExecutionContext = {
      runId: 'pc-security',
      agent: { id: 'fixture', companyId: 'fixture-company', name: 'fixture', adapterType: 'hermes_gateway', adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config, context: {},
      onLog: async (_stream, text) => { logs.push(text); },
      onEvent: async event => { events.push(event); },
    };
    try {
      expect((await execute(ctx)).exitCode).toBe(0);
      expect(events.length).toBeGreaterThan(0);
      for (const value of [credential, headerValue]) {
        expect(JSON.stringify(events)).not.toContain(value);
        expect(logs.join('')).not.toContain(value);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
