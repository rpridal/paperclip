import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, appendFile, readFile, rm } from "node:fs/promises";

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { registerLegacyToolApproval, resolveLegacyToolApproval, clearLegacyToolApprovalsForRun } from "../services/legacy-tool-approval-registry.js";

// Internal disposable route exercises storage/provider sequencing, NOT authority.
// Production agentRoutes remain fail-closed; this fixture grants no live policy.
describe("legacy durable attempt over disposable Express HTTP", () => {
  it.each(["cancel", "expired", "audit-failure"])("withdraws pending %s without provider I/O", async mode => {
    const runId = crypto.randomUUID();
    const records: any[] = [];
    let posts = 0;
    registerLegacyToolApproval({ runId, companyId: "company", agentId: "agent",
      audit: async event => { if (mode === "audit-failure") throw new Error("private-audit-credential"); records.push(event); },
      approval: { provider: "hermes_gateway", providerRunId: "provider", requestId: "request", choices: ["once", "deny"],
        expiresAt: mode === "expired" ? Date.now() - 1 : Date.now() + 5000, resolve: async () => { posts++; } },
    });
    const app = express();
    app.post("/withdraw", async (_req, res) => {
      const pending = clearLegacyToolApprovalsForRun(runId);
      // The fence exists before any awaited persistence.
      expect(await resolveLegacyToolApproval({ runId, requestId: "request", choice: "once" })).toBe(false);
      try { await pending; res.json({ closed: true }); }
      catch (error) { res.status(500).json({ error: (error as Error).message }); }
    });
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/withdraw`, { method: "POST" });
      const result = await response.json();
      expect(posts).toBe(0);
      if (mode === "audit-failure") {
        expect(response.status).toBe(500);
        expect(result.error).toBe("legacy_consent_withdrawal_audit_failed_no_delivery");
      } else {
        expect(response.status).toBe(200);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ phase: "outcome", outcome: mode, runId, requestId: "request" });
        expect(records[0]).not.toHaveProperty("choice");
      }
      expect(await resolveLegacyToolApproval({ runId, requestId: "request", choice: "once" })).toBe(false);
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });
  it.each(["success", "preaudit", "postaudit", "ambiguous", "closing", "persisted-cancel", "expired", "cancel-audit-failure"])("consumes exactly once with %s audit outcome", async mode => {
    const dir = await mkdtemp(join(tmpdir(), "consent-audit-"));
    const file = join(dir, "audit.jsonl");
    const runId = crypto.randomUUID();
    let posts = 0;
    const readAudit = async () => { try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
    const app = express();
    app.use(express.json());
    app.post("/provider", async (_req, res) => {
      posts++;
      expect((await readAudit())[0]).toMatchObject({ phase: "attempt", choice: "once", runId, requestId: "request" });
      if (mode === "ambiguous") { res.destroy(); return; }
      res.json({ resolved: 1 });
    });
    app.post("/fixture-resolve", async (_req, res) => {
      try { res.json({ resolved: await resolveLegacyToolApproval({ runId, requestId: "request", choice: "once" }) }); }
      catch (error) { res.status(500).json({ error: (error as Error).message }); }
    });
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
    const url = `http://127.0.0.1:${address.port}`;
    registerLegacyToolApproval({ runId, companyId: "company", agentId: "agent",
      beforeProvider: async () => ["persisted-cancel", "cancel-audit-failure"].includes(mode) ? "cancel" : null,
      audit: async (event: any) => {
        if (mode === "preaudit" && event.phase === "attempt") throw new Error("fixture audit down");
        if (mode === "postaudit" && event.phase === "outcome") throw new Error("fixture audit down");
        if (mode === "cancel-audit-failure" && event.phase === "outcome") throw new Error("private-audit-credential");
        await appendFile(file, JSON.stringify(event) + "\n", { flush: true });
        if (event.phase === "attempt" && mode === "closing") clearLegacyToolApprovalsForRun(runId);
      },
      approval: { provider: "hermes_gateway", providerRunId: "provider", requestId: "request", choices: ["once", "deny"],
        expiresAt: mode === "expired" ? Date.now() - 1 : Date.now() + 5000,
        prompt: { action: "not-in-generic-audit" },
        resolve: async () => { const response = await fetch(url + "/provider", { method: "POST" }); if (!response.ok) throw new Error("delivery"); },
      },
    } as any);
    try {
      expect(posts).toBe(0);
      const responses = await Promise.all([fetch(url + "/fixture-resolve", { method: "POST" }), fetch(url + "/fixture-resolve", { method: "POST" })]);
      const results = await Promise.all(responses.map(response => response.json()));
      expect(posts).toBe(["preaudit", "closing", "persisted-cancel", "expired", "cancel-audit-failure"].includes(mode) ? 0 : 1);
      const records = await readAudit();
      expect(JSON.stringify(records)).not.toContain("not-in-generic-audit");
      if (mode === "success") {
        expect(records.map(event => event.phase)).toEqual(["attempt", "outcome"]);
        expect(records[1].outcome).toBe("resolved");
        expect(results.some(result => result.resolved === true)).toBe(true);
      } else if (["closing", "persisted-cancel", "expired"].includes(mode)) {
        expect(records[1].outcome).toBe(mode === "expired" ? "expired" : "cancel");
        expect(results.every(result => result.resolved === false)).toBe(true);
      } else {
        expect(results.some(result => typeof result.error === "string")).toBe(true);
        if (mode === "ambiguous") expect(records[1].outcome).toBe("failed-or-unknown");
        if (mode === "postaudit") expect(records.map(event => event.phase)).toEqual(["attempt"]);
        if (mode === "cancel-audit-failure") expect(results.some(result => result.error === "legacy_consent_cancel_outcome_audit_failed_no_delivery")).toBe(true);
      }
      expect(await resolveLegacyToolApproval({ runId, requestId: "request", choice: "once" })).toBe(false);
      expect(registerLegacyToolApproval({ runId, companyId: "company", agentId: "agent", audit: async () => {},
        approval: { provider: "hermes_gateway", providerRunId: "provider", requestId: "request", choices: ["once", "deny"], resolve: async () => {} },
      })).toBe(false);
    } finally {
      clearLegacyToolApprovalsForRun(runId); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done())); await rm(dir, { recursive: true });
    }
  });
});
