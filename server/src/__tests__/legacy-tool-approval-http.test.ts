import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { execute } from '../../../packages/adapters/hermes/src/gateway/server/execute.js';
import { registerLegacyToolApproval, getLegacyToolApproval, resolveLegacyToolApproval, clearLegacyToolApprovalsForRun } from '../services/legacy-tool-approval-registry.js';

describe('legacy approval disposable HTTP transport', () => {
  it.each(['once', 'deny'] as const)('requires exact %s and rejects duplicate consent', async choice => {
    let executions = 0;
    let deliveries = 0;
    let polls = 0;
    let connections = 0;
    let completed = false;
    let registrations = 0;
    const logs: string[] = [];
    const runId = `pc-http-${choice}`;
    const requestId = `request-http-${choice}`;
    const providerRunId = `hermes-http-${choice}`;
    const key = 'disposable-fixture-credential';
    const approval = { event: 'approval.request', request_id: requestId, run_id: providerRunId };
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end(); return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/runs' && req.method === 'POST') {
        res.end(JSON.stringify({ run_id: providerRunId })); return;
      }
      if (req.url === `/v1/runs/${providerRunId}/events`) {
        connections++;
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`event: approval.request\ndata: ${JSON.stringify(approval)}\n\n`); return;
      }
      if (req.url === `/v1/runs/${providerRunId}/approval` && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        if (parsed.request_id !== requestId || completed || !['once', 'deny'].includes(parsed.choice)) {
          res.writeHead(409).end('{}'); return;
        }
        deliveries++;
        if (parsed.choice === 'once') executions++;
        completed = true;
        res.end(JSON.stringify({ run_id: providerRunId, request_id: requestId, choice: parsed.choice, resolved: 1 })); return;
      }
      if (req.url === `/v1/runs/${providerRunId}`) {
        polls++;
        res.end(JSON.stringify({ status: completed ? 'completed' : 'waiting_for_approval', approval })); return;
      }
      res.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    const config = { apiBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: key, pollIntervalMs: 250, eventReconnectMs: 250, timeoutSec: 5 };
    const ctx: AdapterExecutionContext = {
      runId,
      agent: { id: 'fixture-agent', companyId: 'fixture-company', name: 'fixture', adapterType: 'hermes_gateway', adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config, context: { issueId: 'fixture-issue' },
      onLog: async (_stream, text) => { logs.push(text); },
      onLegacyToolApproval: async pending => {
        registrations++;
        registerLegacyToolApproval({ runId, companyId: ctx.agent.companyId, agentId: ctx.agent.id, approval: pending, audit: async () => {} }); // storage fixture only; durable failure coverage is audit-http
      },
    };
    let execution: ReturnType<typeof execute> | undefined;
    try {
      execution = execute(ctx);
      await expect.poll(() => getLegacyToolApproval({ runId, requestId }), { timeout: 2500 }).not.toBeNull();
      await expect.poll(() => polls, { timeout: 2500 }).toBeGreaterThan(0);
      await expect.poll(() => connections, { timeout: 2500 }).toBeGreaterThan(1);
      expect(registrations).toBe(1);
      expect(executions).toBe(0);
      expect(deliveries).toBe(0);
      expect(getLegacyToolApproval({ runId: 'wrong-run', requestId })).toBeNull();
      expect(await resolveLegacyToolApproval({ runId, requestId: 'wrong-request', choice })).toBe(false);
      expect(await resolveLegacyToolApproval({ runId, requestId, choice })).toBe(true);
      expect(await resolveLegacyToolApproval({ runId, requestId, choice })).toBe(false);
      expect((await execution).exitCode).toBe(0);
      expect(deliveries).toBe(1);
      expect(executions).toBe(choice === 'once' ? 1 : 0);
      expect(logs.join('')).not.toContain(key);
    } finally {
      clearLegacyToolApprovalsForRun(runId);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await execution;
    }
  });
});
