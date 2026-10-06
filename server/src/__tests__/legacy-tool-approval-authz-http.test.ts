import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerLegacyToolApproval, clearLegacyToolApprovalsForRun } from "../services/legacy-tool-approval-registry.js";

const fixture = vi.hoisted(() => ({
  run: { id: "11111111-1111-4111-8111-111111111111", companyId: "company", agentId: "developer", status: "running", resultJson: {} },
  audit: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
}));
// Replace storage/service factories only. Route and authz are production modules.
vi.mock("../services/index.js", () => ({
  agentService: () => ({}), agentInstructionsService: () => ({}), accessService: () => ({}),
  approvalService: () => ({}), builtInAgentService: () => ({}), companySkillService: () => ({}),
  budgetService: () => ({}), heartbeatService: () => ({ getRun: async () => fixture.run, cancelRun: fixture.cancel }),
  ISSUE_LIST_DEFAULT_LIMIT: 50, issueApprovalService: () => ({}), issueRecoveryActionService: () => ({}),
  issueService: () => ({}), logActivity: fixture.audit,
  syncInstructionsBundleConfigFromFilePath: vi.fn(), workspaceOperationService: () => ({}),
}));

// The requested Leela ID is not an authorization fixture/grant. These tests
// exercise the absence of a run/request-bound designated resolver contract.
describe("legacy consent designated authority, actual Express HTTP", () => {
  it("reports sanitized withdrawal audit failure after actual cancellation route", async () => {
    fixture.run.id = crypto.randomUUID();
    fixture.cancel.mockClear();
    const { agentRoutes } = await import("../routes/agents.js");
    registerLegacyToolApproval({ runId: fixture.run.id, companyId: "company", agentId: "developer",
      audit: async () => { throw new Error("private-audit-credential"); },
      approval: { provider: "hermes_gateway", providerRunId: "provider", requestId: "request", choices: ["once", "deny"], resolve: async () => { throw new Error("must not resolve"); } } });
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true } as any; next(); });
    app.use("/api", agentRoutes({} as any));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/heartbeat-runs/${fixture.run.id}/cancel`, { method: "POST" });
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "legacy_consent_withdrawal_audit_failed_no_delivery" });
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });
  it.each([
    { type: "board", source: "local_implicit", isInstanceAdmin: true },
    { type: "board", source: "session", userId: "operator", companyIds: ["company"], isInstanceAdmin: true },
    { type: "board", source: "session", userId: "restore-only", companyIds: ["company"] },
    { type: "board", source: "session", userId: "unrelated-user", companyIds: ["other-company"] },
    { type: "agent", source: "agent_jwt", companyId: "other-company", agentId: "e95a6909-1ad8-4b8e-9fa3-2fe123107844" },
    { type: "agent", source: "agent_jwt", companyId: "company", agentId: "e95a6909-1ad8-4b8e-9fa3-2fe123107844" },
  ])("does not turn $source / $type into designated consent", async actor => {
    fixture.run.id = crypto.randomUUID();
    fixture.audit.mockClear();
    const { agentRoutes } = await import("../routes/agents.js");
    let posts = 0;
    registerLegacyToolApproval({ runId: fixture.run.id, companyId: fixture.run.companyId, agentId: fixture.run.agentId,
      audit: fixture.audit,
      approval: { provider: "hermes_gateway", providerRunId: "provider-run", requestId: "request", choices: ["once", "deny"], resolve: async () => { posts++; } } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    app.use("/api", agentRoutes({} as any));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message, details: error.details }));
    const server = createServer(app);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port missing");
    try {
      const read = await fetch(`http://127.0.0.1:${address.port}/api/heartbeat-runs/${fixture.run.id}/legacy-tool-approvals/request`);
      expect(read.status).toBe(403);
      expect(await read.text()).not.toContain("provider-run");
      const responses = await Promise.all([0, 1].map(() => fetch(`http://127.0.0.1:${address.port}/api/heartbeat-runs/${fixture.run.id}/legacy-tool-approvals/request/resolve`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice: "once", resolverAgentId: "e95a6909-1ad8-4b8e-9fa3-2fe123107844" }) })));
      expect(responses.map(response => response.status)).toEqual([403, 403]);
      expect(posts).toBe(0);
      expect(fixture.audit).not.toHaveBeenCalled();
    } finally {
      await clearLegacyToolApprovalsForRun(fixture.run.id);
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    }
  });
});
