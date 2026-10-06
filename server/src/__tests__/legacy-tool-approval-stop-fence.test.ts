import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { execFileSync } from "node:child_process";
import express from "express";
import { describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({ heartbeat: {} as any }));
vi.mock("../services/index.js", () => ({
  agentService: () => ({}), agentInstructionsService: () => ({}), accessService: () => ({}),
  approvalService: () => ({}), builtInAgentService: () => ({}), companySkillService: () => ({}),
  budgetService: () => ({}), heartbeatService: () => services.heartbeat,
  ISSUE_LIST_DEFAULT_LIMIT: 50, issueApprovalService: () => ({}), issueRecoveryActionService: () => ({}),
  issueService: () => ({}), logActivity: async () => {},
  syncInstructionsBundleConfigFromFilePath: vi.fn(), workspaceOperationService: () => ({}),
}));
import * as registry from "../services/legacy-tool-approval-registry.js";

// HTTP tests mount actual agentRoutes/authz. Heartbeat callback/internal-entry
// closures remain supplementary unit evidence, not designated auth acceptance.
function loadClosure(file: string, start: string, end: string, deps: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0 || source.indexOf(start, begin + 1) >= 0) throw new Error(`Missing/ambiguous production closure in ${file}`);
  const code = stripTypeScriptTypes(`const closure = ${source.slice(begin + start.length, finish)};`);
  return new Function("db", "logActivity", ...Object.keys(deps), `${code}; return closure;`)({}, async () => {}, ...Object.values(deps));
}
function route(path: string, deps: Record<string, unknown>) {
  return async (req: any, _res: unknown) => {
    services.heartbeat = deps.heartbeat;
    const { agentRoutes } = await import("../routes/agents.js");
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { request.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true } as any; next(); });
    app.use("/api", agentRoutes({} as any));
    app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).json({ error: error.message }));
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
    try {
      const result = await fetch(`http://127.0.0.1:${address.port}/api${path.replace(":runId", req.params.runId).replace(":requestId", req.params.requestId ?? "")}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body ?? {}),
      });
      const body = await result.json();
      if (!result.ok) throw Object.assign(new Error(body.error), { status: result.status });
      return body;
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = () => ({ status() { return this; }, json() {} });
function register(input: Parameters<typeof registry.registerLegacyToolApproval>[0]) {
  return registry.registerLegacyToolApproval({ audit: async () => {}, ...input });
}
const run = (id: string, resultJson = {}) => ({ id, companyId: "company", agentId: "agent", status: "running", resultJson });
function dependencies(heartbeat: unknown) {
  return { heartbeat };
}
async function fixture(body: (approval: (requestId: string) => any, posts: () => number) => Promise<void>) {
  let posts = 0;
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} posts++; res.end("{}"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port missing");
  try {
    await body(requestId => ({ requestId, provider: "hermes", providerRunId: "provider-run", choices: ["once", "deny"],
      resolve: async (choice: string) => { await fetch(`http://127.0.0.1:${address.port}/approval`, { method: "POST", body: JSON.stringify({ requestId, choice }) }); } }), () => posts);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}

describe("legacy synchronous stop fence", () => {
  it("wrong-run stop leaves another run pending and resolvable", async () => fixture(async (approval, posts) => {
    const runId = "11111111-1111-4111-8111-111111111110";
    register({ runId, companyId: "company", agentId: "agent", approval: approval("same-request") });
    const otherId = "11111111-1111-4111-8111-111111111111";
    const cancel = route("/heartbeat-runs/:runId/cancel", dependencies({ getRun: async () => run(otherId), cancelRun: async () => run(otherId) }));
    try {
      await cancel({ params: { runId: otherId }, actor: {} }, response());
      expect(registry.getLegacyToolApproval({ runId, requestId: "same-request" })).not.toBeNull();
      expect(await registry.resolveLegacyToolApproval({ runId, requestId: "same-request", choice: "once" })).toBe(true);
      expect(posts()).toBe(1);
    } finally { await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("terminal cleanup cannot reopen a delayed running snapshot", async () => fixture(async (approval, posts) => {
    const runId = "11111111-1111-4111-8111-111111111112"; const late = deferred<any>();
    const callback = loadClosure("../services/heartbeat.ts", "const onLegacyToolApproval = ", ";\n\n        const onAdapterEvent", {
      ...registry, currentRun: run(runId), getRun: () => late.promise, appendRunEvent: async () => {},
      parseObject: (value: unknown) => value && typeof value === "object" ? value : {},
    });
    register({ runId, companyId: "company", agentId: "agent", approval: approval("pending") });
    const pending = callback(approval("late"));
    const resolve = route("/heartbeat-runs/:runId/legacy-tool-approvals/:requestId/resolve", dependencies({ getRun: async () => ({ ...run(runId), status: "cancelled" }) }));
    try {
      await expect(resolve({ params: { runId, requestId: "pending" }, body: { choice: "once" }, actor: {} }, response())).rejects.toMatchObject({ status: 409 });
      await registry.clearLegacyToolApprovalsForRun(runId); // definitive termination cleanup is idempotent
      late.resolve(run(runId)); await pending;
      expect(registry.getLegacyToolApproval({ runId, requestId: "late" })).toBeNull();
      expect(posts()).toBe(0);
    } finally { late.resolve(run(runId)); await pending; await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("fresh process cannot resolve persisted identifiers without credentials", async () => fixture(async (approval, posts) => {
    const runId = "fence-restart";
    register({ runId, companyId: "company", agentId: "agent", approval: approval("pending") });
    try {
      const moduleUrl = new URL("../services/legacy-tool-approval-registry.ts", import.meta.url).href;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const r = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([r.getLegacyToolApproval({runId:'fence-restart',requestId:'pending'}),await r.resolveLegacyToolApproval({runId:'fence-restart',requestId:'pending',choice:'once'})]));`], { encoding: "utf8", timeout: 5000 });
      expect(JSON.parse(output)).toEqual([null, false]); expect(posts()).toBe(0);
    } finally { await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("concurrent resolvers consume exactly once before provider I/O", async () => fixture(async (approval, posts) => {
    const runId = "fence-concurrent"; const entered = deferred<void>(); const release = deferred<void>();
    const provider = approval("pending");
    register({ runId, companyId: "company", agentId: "agent", approval: { ...provider, resolve: async (choice: string) => { entered.resolve(); await release.promise; await provider.resolve(choice); } } });
    // Internal storage/provider race, not a positive designated route fixture.
    const resolve = () => registry.resolveLegacyToolApproval({ runId, requestId: "pending", choice: "once" });
    const first = resolve(); await entered.promise;
    try {
      expect(await resolve()).toBe(false); expect(posts()).toBe(0);
      release.resolve(); await first; expect(posts()).toBe(1);
    } finally { release.resolve(); await first; await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("ambiguous provider delivery is never retried even after stop", async () => fixture(async (approval, posts) => {
    const runId = "fence-ambiguous"; const provider = approval("pending");
    register({ runId, companyId: "company", agentId: "agent", approval: { ...provider, resolve: async (choice: string) => { await provider.resolve(choice); throw new Error("ambiguous delivery"); } } });
    await expect(registry.resolveLegacyToolApproval({ runId, requestId: "pending", choice: "once" })).rejects.toThrow("legacy_consent_delivery_failed_or_unknown_no_retry");
    await registry.clearLegacyToolApprovalsForRun(runId);
    expect(await registry.resolveLegacyToolApproval({ runId, requestId: "pending", choice: "once" })).toBe(false);
    expect(register({ runId, companyId: "company", agentId: "agent", approval: provider })).toBe(false);
    expect(posts()).toBe(1); // fencing does not roll back an already-started POST
  }));
  it("does not register callbacks from persisted requested cancellation", async () => fixture(async (approval, posts) => {
    const runId = "fence-requested-callback";
    const callback = loadClosure("../services/heartbeat.ts", "const onLegacyToolApproval = ", ";\n\n        const onAdapterEvent", {
      ...registry, currentRun: run(runId), getRun: async () => run(runId, { executionCancellation: { state: "requested" } }),
      appendRunEvent: async () => {}, parseObject: (value: unknown) => value && typeof value === "object" ? value : {},
    });
    try {
      await callback(approval("late"));
      expect(registry.getLegacyToolApproval({ runId, requestId: "late" })).toBeNull(); expect(posts()).toBe(0);
    } finally { await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("rejects persisted requested cancellation before provider POST", async () => fixture(async (approval, posts) => {
    const runId = "11111111-1111-4111-8111-111111111113";
    const snapshot = run(runId, { executionCancellation: { state: "requested" } });
    register({ runId, companyId: "company", agentId: "agent", approval: approval("pending") });
    const resolve = route("/heartbeat-runs/:runId/legacy-tool-approvals/:requestId/resolve", dependencies({ getRun: async () => snapshot }));
    try {
      const outcome = await resolve({ params: { runId, requestId: "pending" }, body: { choice: "once" }, actor: {} }, response()).then(() => 202, (error: any) => error.status);
      expect(posts()).toBe(0); expect(outcome).toBe(409);
    } finally { await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("internal stop fences before its deferred getRun even when lookup fails", async () => fixture(async (approval, posts) => {
    const runId = "fence-internal"; const lookup = deferred<any>();
    const source = readFileSync(new URL("../services/heartbeat.ts", import.meta.url), "utf8");
    const begin = source.indexOf("  async function cancelRunInternal(");
    const end = source.indexOf("    const pendingNativeRetry =", begin);
    // Execute the production entry through its first lookup, then return.
    const entry = stripTypeScriptTypes(`${source.slice(begin, end)} return run; }`);
    const cancel = new Function("logger", "getRun", "notFound", "clearLegacyToolApprovalsForRun", `${entry}; return cancelRunInternal;`)(
      { error() {} }, () => lookup.promise, (message: string) => new Error(message), registry.clearLegacyToolApprovalsForRun);
    register({ runId, companyId: "company", agentId: "agent", approval: approval("pending") });
    expect(registry.getLegacyToolApproval({ runId, requestId: "pending" })).not.toBeNull();
    const stop = cancel(runId).catch(() => null);
    try {
      await registry.resolveLegacyToolApproval({ runId, requestId: "pending", choice: "once" });
      expect(posts()).toBe(0);
    } finally { lookup.resolve(null); await stop; await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("rejects stale callback registration after deferred getRun crosses clear", async () => fixture(async (approval, posts) => {
    const runId = "fence-stale-callback"; const snapshot = deferred<any>();
    const callback = loadClosure("../services/heartbeat.ts", "const onLegacyToolApproval = ", ";\n\n        const onAdapterEvent", {
      ...registry, currentRun: run(runId), getRun: () => snapshot.promise, appendRunEvent: async () => {},
      parseObject: (value: unknown) => value && typeof value === "object" ? value : {},
    });
    const pending = callback(approval("late"));
    await registry.clearLegacyToolApprovalsForRun(runId);
    snapshot.resolve(run(runId)); await pending;
    try {
      expect(registry.getLegacyToolApproval({ runId, requestId: "late" })).toBeNull();
      expect(await registry.resolveLegacyToolApproval({ runId, requestId: "late", choice: "once" })).toBe(false);
      expect(posts()).toBe(0);
    } finally { await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
  it("fences resolve while cancelRun is still deferred", async () => fixture(async (approval, posts) => {
    const runId = "11111111-1111-4111-8111-111111111114"; const stopped = deferred<any>(); const entered = deferred<void>();
    const heartbeat = { getRun: async () => run(runId), cancelRun: () => { entered.resolve(); return stopped.promise; } };
    const deps = dependencies(heartbeat);
    const cancel = route("/heartbeat-runs/:runId/cancel", deps);
    const resolve = route("/heartbeat-runs/:runId/legacy-tool-approvals/:requestId/resolve", deps);
    register({ runId, companyId: "company", agentId: "agent", approval: approval("pending") });
    expect(registry.getLegacyToolApproval({ runId, requestId: "pending" })).not.toBeNull(); expect(posts()).toBe(0);
    const stop = cancel({ params: { runId }, actor: {} }, response()); await entered.promise;
    try {
      const outcome = await resolve({ params: { runId, requestId: "pending" }, body: { choice: "once" }, actor: {} }, response()).then(() => 202, (error: any) => error.status);
      expect(posts()).toBe(0); expect(outcome).toBe(409);
    } finally { stopped.resolve(run(runId)); await stop; await registry.clearLegacyToolApprovalsForRun(runId); }
  }));
});
