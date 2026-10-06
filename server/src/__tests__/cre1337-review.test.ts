import { describe, expect, it, vi } from "vitest";
import { issues, issueThreadInteractions, toolActionRequests, companySecretProposals, activityLog, heartbeatRuns } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-thread-interactions.js";
import { publishActivity } from "../services/activity-log.js";
const sink = vi.hoisted(() => ({ live: [] as any[] }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: (e: any) => sink.live.push(e) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => {} }));
function fixture(config: { linked?: boolean; noResult?: boolean; runStatus?: string; runError?: Error; requested?: boolean } = {}) {
  sink.live.length = 0;
  const events: string[] = [], queries: any[] = [], patches: any[] = [], audits: any[] = [];
  const dialect = new PgDialect();
  let release!: () => void, releaseRun!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const runBarrier = new Promise<void>(resolve => { releaseRun = resolve; });
  const row: any = { id: "interaction-1", companyId: "company-1", issueId: "issue-1", kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Offline fixture", ...(config.linked ? { secretProposal: { version: 1, proposalId: "11111111-1111-4111-8111-111111111111", sourceSecretLabel: "synthetic-label", configPath: "env.SYNTHETIC", targetAgentId: "22222222-2222-4222-8222-222222222222", targetAgentName: "fixture", justification: "offline", expiresAt: "2030-01-01T00:00:00.000Z" } } : {}) }, result: null };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async (q: any) => { events.push("fence"); queries.push(dialect.sqlToQuery(q)); await barrier; },
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      if (table === issues) return { for: async (mode: string) => { expect(mode).toBe("update"); events.push("issue-lock"); return [{ id: "issue-1", companyId: "company-1", status: "blocked" }]; } };
      if (table === heartbeatRuns) return { for: async (mode: string) => { expect(mode).toBe("share"); events.push("actor-run"); await runBarrier; if (config.runError) throw config.runError; return [{ status: config.runStatus ?? "running", resultJson: config.requested ? { executionCancellation: { state: "requested" } } : {} }]; } };
      if (table === issueThreadInteractions) { events.push("card-read"); return Promise.resolve([row]); }
      expect(table).toBe(toolActionRequests); events.push("active-tool-read"); return Promise.resolve([]);
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q)); patches.push(patch);
      if (table === toolActionRequests) { events.push("tool-write"); return Promise.resolve(); }
      if (table === companySecretProposals) { events.push("secret-write"); return { returning: async () => [{ id: "proposal-1", proposedByAgentId: null, originRunId: null, originIssueId: "issue-1" }] }; }
      expect(table).toBe(issueThreadInteractions); events.push("card-write"); return { returning: async () => config.noResult ? [] : [{ ...row, ...patch }] };
    } }) }),
    insert: (table: any) => { expect(table).toBe(activityLog); return { values: (value: any) => { events.push("audit-write"); audits.push(value); return { returning: async () => [{ id: "audit-1" }] }; } }; },
  };
  const root: any = { ...tx, transaction: async (cb: any) => { events.push("tx"); return cb(tx); }, update: (table: any) => table === issues ? { set: () => ({ where: async () => events.push("touch") }) } : tx.update(table) };
  return { tx, root, row, events, queries, patches, audits, release, releaseRun };
}
const invoke = (f: ReturnType<typeof fixture>, actor: any = { userId: "user-1" }, options: any = { postCommitPublications: [] }) =>
  (service as any).withdrawInteractionInTransaction(f.tx, { id: "issue-1", companyId: "company-1" }, "interaction-1", { reason: " Original " }, actor, options);
describe("independent withdrawal probes", () => {
  it("captures caller queue while actual linked-secret logger defers success publication", async () => {
    const f = fixture({ linked: true }); const sentinel = { sentinel: true }; const queue: any[] = [sentinel]; const replacement: any[] = [];
    const options = { postCommitPublications: queue }; const pending = invoke(f, undefined, options);
    expect(f.events).toEqual(["fence"]); options.postCommitPublications = replacement; f.release();
    const result = await pending;
    expect(result.status).toBe("cancelled"); expect(queue).toHaveLength(2); expect(queue[0]).toBe(sentinel); expect(replacement).toEqual([]); expect(sink.live).toEqual([]);
    expect(f.audits[0]).toMatchObject({ action: "secret.proposal.withdrawn", actorType: "user", actorId: "user-1", responsibleUserId: "user-1" });
    expect(f.events).toEqual(["fence", "issue-lock", "card-read", "tool-write", "secret-write", "audit-write", "active-tool-read", "card-write"]);
    publishActivity(queue[1]); expect(sink.live).toHaveLength(1);
    expect(f.queries[1]).toMatchObject({ sql: '("issues"."id" = $1 and "issues"."company_id" = $2)', params: ["issue-1", "company-1"] });
    expect(f.queries[2]).toMatchObject({ sql: '("issue_thread_interactions"."id" = $1 and "issue_thread_interactions"."company_id" = $2 and "issue_thread_interactions"."issue_id" = $3)', params: ["interaction-1", "company-1", "issue-1"] });
    expect(f.queries.at(-1)).toMatchObject({ sql: '("issue_thread_interactions"."id" = $1 and "issue_thread_interactions"."status" = $2 and "issue_thread_interactions"."company_id" = $3 and "issue_thread_interactions"."issue_id" = $4)', params: ["interaction-1", "pending", "company-1", "issue-1"] });
  });
  it("lost card CAS retains caller-discard queue without emitting linked audit", async () => {
    const f = fixture({ linked: true, noResult: true }); const queue: any[] = []; f.release();
    await expect(invoke(f, undefined, { postCommitPublications: queue })).rejects.toMatchObject({ status: 409 });
    expect(f.audits).toHaveLength(1); expect(queue).toHaveLength(1); expect(sink.live).toEqual([]);
  });
  it("actor-run barrier precedes every linked/card write and captures agent/run", async () => {
    const f = fixture(); f.release(); const actor = { agentId: "agent-1", runId: "run-1" }; const pending = invoke(f, actor);
    for (let n=0;n<12;n++) await Promise.resolve();
    try { expect(f.events).toEqual(["fence", "issue-lock", "card-read", "issue-lock", "actor-run"]); expect(f.patches).toEqual([]); actor.agentId="other"; actor.runId="other"; }
    finally { f.releaseRun(); }
    const result = await pending; expect(result).toMatchObject({ resolvedByAgentId: "agent-1", resolvedByRunId: "run-1" });
    expect(f.queries[4]).toMatchObject({ sql: '("heartbeat_runs"."id" = $1 and "heartbeat_runs"."company_id" = $2 and "heartbeat_runs"."agent_id" = $3)', params: ["run-1", "company-1", "agent-1"] });
  });
  for (const config of [{ runStatus: "cancelled" }, { requested: true }]) it(`actor-run revocation rejects before linked writes ${JSON.stringify(config)}`, async () => {
    const f = fixture(config); f.release(); f.releaseRun(); await expect(invoke(f, { agentId: "agent-1", runId: "run-1" })).rejects.toMatchObject({ status: 403 }); expect(f.patches).toEqual([]);
  });
  it("actor-run storage rejection propagates before linked writes", async () => {
    const error = new Error("run-storage"); const f = fixture({ runError: error }); f.release(); f.releaseRun(); await expect(invoke(f, { agentId: "agent-1", runId: "run-1" })).rejects.toBe(error); expect(f.patches).toEqual([]);
  });
  it("absent queue rejects before fence", async () => {
    const f = fixture({ linked: true }); await expect(invoke(f, undefined, {})).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
  });
  it("direct dark canonical path rejects hooks before fence", async () => {
    const f = fixture(); await expect((service.issueThreadInteractionService(f.tx) as any).withdrawInteraction({ id:"issue-1", companyId:"company-1" }, "interaction-1", {}, {}, { afterResolveInTransaction: () => { throw new Error("hook"); } }, { tx:f.tx, postCommitPublications:[] })).rejects.toMatchObject({status:422}); expect(f.events).toEqual([]);
  });
  for (const reason of [undefined, null, "", "  original  "]) it(`ordinary parity reason ${JSON.stringify(reason)}`, async () => {
    const f = fixture({ linked: true });
    const pending = service.issueThreadInteractionService(f.root).withdrawInteraction({id:"issue-1",companyId:"company-1"}, "interaction-1", {reason} as any, {userId:"user-1"});
    if (reason === null) { await expect(pending).rejects.toHaveProperty("name", "ZodError"); expect(f.events).toEqual([]); return; }
    const result = await pending;
    expect(result).toMatchObject({status:"cancelled",result:{reason:reason?.trim() || null}}); expect(f.events[0]).toBe("card-read"); expect(f.events).not.toContain("fence"); expect(f.events).toContain("tx"); expect(f.events.at(-1)).toBe("touch"); expect(sink.live).toHaveLength(1);
  });
});
