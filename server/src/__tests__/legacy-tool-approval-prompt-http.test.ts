import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../../../packages/adapters/hermes/src/gateway/server/execute.js";
import { registerLegacyToolApproval, getLegacyToolApproval, clearLegacyToolApprovalsForRun } from "../services/legacy-tool-approval-registry.js";

// Real provider envelope: api_server._approval_request_event copies command and
// description from approval_data, with command redacted before egress. Neither
// turn identity nor a tool/risk taxonomy is guaranteed by that contract.
describe("immutable legacy prompt over disposable Express/provider HTTP", () => {
  it.each(["sse", "poll", "timeout", "disconnect", "cancel"])("binds exact immutable redacted %s prompt without executing", async transport => {
    const runId = crypto.randomUUID();
    const providerRunId = "provider-prompt";
    const requestId = "request-prompt";
    const credential = "disposable-prompt-fixture-credential";
    let posts = 0;
    let captured: any;
    let adapterApproval: any;
    const controller = new AbortController();
    const outcomes: any[] = [];
    const envelope = { event: "approval.request", run_id: providerRunId, request_id: requestId,
      command: `fixture-action ${credential}`, description: `fixture-reason ${credential}`,
      arbitrary: "must-not-copy", turn_id: "not-a-contracted-turn" };
    const app = express();
    app.post("/v1/runs", (_req, res) => res.json({ run_id: providerRunId }));
    app.get(`/v1/runs/${providerRunId}/events`, (_req, res) => {
      res.type("text/event-stream");
      if (transport === "poll") { res.end(": waiting\n\n"); return; }
      res.write(`event: approval.request\ndata: ${JSON.stringify(envelope)}\n\n`);
      if (transport === "sse") res.end('event: run.completed\ndata: {"status":"completed"}\n\n');
      if (transport === "disconnect") res.end();
    });
    app.get(`/v1/runs/${providerRunId}`, (_req, res) => res.json(captured && ["sse", "poll"].includes(transport)
      ? { run_id: providerRunId, status: "completed" }
      : { run_id: providerRunId, status: "waiting_for_approval", last_event: "approval.request", approval: envelope }));
    app.post(`/v1/runs/${providerRunId}/approval`, (_req, res) => { posts++; res.json({}); });
    app.post(`/v1/runs/${providerRunId}/stop`, (_req, res) => res.json({ run_id: providerRunId, status: "cancelled" }));
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const config = { apiBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: credential, pollIntervalMs: 250, eventReconnectMs: 250, timeoutSec: 3 };
    const logs: string[] = [];
    const ctx: AdapterExecutionContext = {
      signal: controller.signal,
      runId, agent: { id: "developer", companyId: "company", name: "fixture", adapterType: "hermes_gateway", adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, context: {},
      onLog: async (_stream, text) => { logs.push(text); },
      onLegacyToolApproval: async approval => {
        adapterApproval = approval;
        expect(approval.isClosed?.()).toBe(false);
        expect(approval.expiresAt).toBeGreaterThan(Date.now());
        expect(registerLegacyToolApproval({ runId, companyId: "company", agentId: "developer", approval, audit: async event => { outcomes.push(event); } })).toBe(true);
        captured = getLegacyToolApproval({ runId, requestId });
        // A held adapter object cannot mutate the request record after publication.
        try { (approval as any).prompt.action = "changed"; } catch {}
        expect(getLegacyToolApproval({ runId, requestId })).toEqual(captured);
        if (transport === "cancel") controller.abort();
      },
    };
    try {
      if (["timeout", "disconnect"].includes(transport)) ctx.config.timeoutSec = 0.2;
      const result = await execute(ctx);
      expect(result.exitCode).toBe(["sse", "poll"].includes(transport) ? 0 : 1);
      expect(adapterApproval.isClosed()).toBe(true);
      await clearLegacyToolApprovalsForRun(runId);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe(["timeout", "disconnect"].includes(transport) ? "expired" : "cancel");
      expect(captured).toMatchObject({ companyId: "company", agentId: "developer", providerRunId, requestId,
        prompt: { action: "fixture-action [redacted len=36]", reason: "fixture-reason [redacted len=36]" } });
      expect(Object.isFrozen(captured.prompt)).toBe(true);
      expect(captured.prompt).not.toHaveProperty("arbitrary");
      expect(captured.prompt).not.toHaveProperty("turnId");
      expect(captured.prompt).not.toHaveProperty("tool");
      expect(posts).toBe(0);
      expect(logs.join("")).not.toContain(credential);
    } finally {
      await clearLegacyToolApprovalsForRun(runId); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});
