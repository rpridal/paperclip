import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition as transition,
  buildIssueMonitorTriggeredPatch,
  buildIssueMonitorClearedPatch,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
function fixture(restart = true, maxReviewRounds = 3) {
  const policy = normalizeIssueExecutionPolicy({ restartReviewOnChangesRequested: restart,
    maxReviewRounds, stages: ids.slice(1).map((agentId, i) => ({
      type: i === 0 ? "review" : "approval", participants: [{ type: "agent", agentId }],
    })), monitor: { nextCheckAt: "2099-01-01T00:00:00Z", maxAttempts: 5,
      timeoutAt: "2099-01-02T00:00:00Z", recoveryPolicy: "wake_owner" } })!;
  let issue: any = { status: "in_progress", assigneeAgentId: ids[0], executionPolicy: policy,
    responsibleUserId: "owner", monitorAttemptCount: 1 };
  function step(actor: string, status: string, body = "exact-head decision") {
    const persistedPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);
    const result = transition({ issue, policy: persistedPolicy, requestedStatus: status, requestedAssigneePatch: {},
      actor: { agentId: actor }, commentBody: body });
    issue = { ...issue, status, ...result.patch };
    return result;
  }
  return { policy, step, get issue() { return issue; } };
}

describe("opt-in independent re-review", () => {
  it.each(["trigger", "clear", "attempts", "timeout"] as const)(
    "preserves re-review and cap after persisted monitor %s",
    (removal) => {
      const f = fixture(true, 2);
      f.step(ids[0], "in_review");
      const beforePolicy = structuredClone(f.issue.executionPolicy);
      const beforeMonitor = structuredClone(f.issue.executionState.monitor);
      if (removal === "trigger") {
        Object.assign(f.issue, buildIssueMonitorTriggeredPatch({ issue: f.issue,
          policy: normalizeIssueExecutionPolicy(f.issue.executionPolicy), triggeredAt: new Date() }));
      } else if (removal === "clear") {
        Object.assign(f.issue, buildIssueMonitorClearedPatch({ issue: f.issue,
          policy: normalizeIssueExecutionPolicy(f.issue.executionPolicy), clearReason: "manual" }));
      } else {
        if (removal === "attempts") {
          f.issue.monitorAttemptCount = 5;
          f.issue.executionState.monitor.attemptCount = 5;
        } else {
          f.issue.executionPolicy.monitor.timeoutAt = "2000-01-01T00:00:00Z";
        }
        f.step(ids[1], "done");
      }
      const { monitor: _monitor, ...expectedPolicy } = beforePolicy;
      expect(f.issue.executionPolicy).toEqual(expectedPolicy);
      expect(f.issue.executionState.monitor).toMatchObject({
        attemptCount: removal === "trigger" ? 2 : removal === "attempts" ? 5 : 1,
        maxAttempts: beforeMonitor.maxAttempts,
        timeoutAt: removal === "timeout" ? "2000-01-01T00:00:00Z" : beforeMonitor.timeoutAt,
      });
      if (removal === "trigger" || removal === "clear") f.step(ids[1], "done");
      const rejected = f.step(ids[2], "in_progress");
      expect(rejected.decision?.stageId).toBe(f.policy.stages[1].id);
      expect(() => f.step(ids[2], "in_review")).toThrow(/Only the return assignee/);
      f.step(ids[0], "in_review");
      expect(f.issue.assigneeAgentId).toBe(ids[1]);
      expect(f.issue.executionState.completedStageIds).toEqual([]);
      f.step(ids[1], "done");
      f.step(ids[2], "in_progress");
      expect(f.issue.assigneeUserId).toBe("owner");
      expect(f.issue.executionState.changesRequestedCount).toBe(2);
      expect(() => f.step(ids[0], "done")).toThrow(/Only the escalated reviewer/);
      expect(f.issue.assigneeUserId).toBe("owner");
    },
  );

  it("requires fresh review and delivery after verifier rejection", () => {
    const f = fixture();
    f.step(ids[0], "in_review");
    f.step(ids[1], "done");
    f.step(ids[2], "done");
    expect(() => f.step(ids[3], "in_progress", "")).toThrow(/requires a comment/);
    f.step(ids[3], "in_progress");
    f.step(ids[0], "in_review");
    expect(f.issue.assigneeAgentId).toBe(ids[1]);
    expect(f.issue.executionState.completedStageIds).toEqual([]);
    expect(f.issue.executionState.monitor.attemptCount).toBe(1);
  });

  it("preserves escalation bounds across successful re-review and delivery rejection", () => {
    const f = fixture(true, 2);
    f.step(ids[0], "in_review");
    f.step(ids[1], "done");
    f.step(ids[2], "in_progress");
    f.step(ids[0], "in_review");
    f.step(ids[1], "done");
    f.step(ids[2], "in_progress");
    expect(f.issue.assigneeUserId).toBe("owner");
    expect(f.issue.executionState.currentStageId).toBe(f.policy.stages[0].id);
    expect(f.issue.executionState.completedStageIds).toEqual([]);
    expect(f.issue.executionState.changesRequestedCount).toBe(2);
    expect(() => f.step(ids[0], "done")).toThrow(/Only the escalated reviewer/);
  });

  it("keeps default legacy resubmit at delivery", () => {
    const f = fixture(false);
    f.step(ids[0], "in_review");
    f.step(ids[1], "done");
    f.step(ids[2], "in_progress");
    f.step(ids[0], "in_review");
    expect(f.issue.assigneeAgentId).toBe(ids[2]);
    expect(f.issue.executionState.completedStageIds).toEqual([f.policy.stages[0].id]);
  });

  it("invalidates completed gates after delivery rejection, preserving monitor and verifier", () => {
    const f = fixture();
    f.step(ids[0], "in_review");
    f.step(ids[1], "done");
    expect(f.issue.assigneeAgentId).toBe(ids[2]);
    const decision = f.step(ids[2], "in_progress", "head moved; request fresh review");
    expect(decision.decision?.stageId).toBe(f.policy.stages[1].id);
    expect(f.issue.assigneeAgentId).toBe(ids[0]);
    expect(() => f.step(ids[2], "in_review", "foreign resubmit")).toThrow(/Only the return assignee/);
    f.step(ids[0], "in_review");
    expect(f.issue.assigneeAgentId).toBe(ids[1]);
    expect(f.issue.executionState.completedStageIds).toEqual([]);
    expect(f.issue.executionState.changesRequestedCount).toBe(1);
    expect(f.issue.executionState.monitor).toMatchObject({ status: "scheduled", attemptCount: 1,
      maxAttempts: 5, timeoutAt: "2099-01-02T00:00:00Z", recoveryPolicy: "wake_owner" });
    expect(f.issue.executionPolicy).toEqual(f.policy);
    expect(() => f.step(ids[2], "done")).toThrow(/Only the active reviewer/);
    expect(() => f.step(ids[0], "done")).toThrow(/Only the active reviewer/);
    f.step(ids[1], "done");
    f.step(ids[2], "done");
    expect(f.issue.assigneeAgentId).toBe(ids[3]);
    expect(f.issue.status).toBe("in_review");
    f.step(ids[3], "done");
    expect(f.issue.executionState.status).toBe("completed");
  });
});
