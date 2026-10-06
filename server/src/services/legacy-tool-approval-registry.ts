import { randomUUID } from "node:crypto";
import type { AdapterLegacyToolApproval } from "@paperclipai/adapter-utils";

export type LegacyConsentAuditEvent = Readonly<{
  attemptId: string;
  companyId: string;
  runId: string;
  provider: "hermes_gateway";
  providerRunId: string;
  requestId: string;
  choice?: "once" | "deny";
  phase: "attempt" | "outcome";
  outcome?: "resolved" | "deny" | "cancel" | "expired" | "failed-or-unknown";
}>;

type Registration = {
  companyId: string;
  agentId: string;
  approval: AdapterLegacyToolApproval;
  consumed: boolean;
  audit?: (event: LegacyConsentAuditEvent) => Promise<void>;
  beforeProvider?: () => Promise<"cancel" | null>;
};

const registrations = new Map<string, Registration>();
// No history rehydration; retains only process-local consumed identifiers.
const consumedRequests = new Set<string>();
// Run IDs are immutable. Keep closing tombstones for this process lifetime:
// terminal cleanup must not reopen a delayed callback holding a running snapshot.
// Restart drops both tombstones and resolver credentials, so it fails closed.
const closingRuns = new Set<string>();

function key(runId: string, requestId: string): string {
  return `${runId}\u0000${requestId}`;
}

/**
 * Process-local on purpose: provider credentials stay in the active adapter
 * closure. Restart/disconnect therefore fails closed rather than replaying a
 * consent from persisted history.
 */
export function registerLegacyToolApproval(input: {
  runId: string;
  companyId: string;
  agentId: string;
  approval: AdapterLegacyToolApproval;
  /** Server-owned durable storage; never supplied by an HTTP caller. */
  audit?: (event: LegacyConsentAuditEvent) => Promise<void>;
  beforeProvider?: () => Promise<"cancel" | null>;
}): boolean {
  if (closingRuns.has(input.runId)) return false;
  const registrationKey = key(input.runId, input.approval.requestId);
  if (registrations.has(registrationKey) || consumedRequests.has(registrationKey)) return false;
  registrations.set(registrationKey, {
    companyId: input.companyId,
    agentId: input.agentId,
    approval: Object.freeze({
      ...input.approval,
      choices: Object.freeze(["once", "deny"] as const),
      // Copy primitives only; never retain a provider-owned mutable prompt.
      prompt: Object.freeze(Object.fromEntries(
        ["tool", "action", "reason", "risk"].flatMap(field => {
          const value = input.approval.prompt?.[field as keyof NonNullable<AdapterLegacyToolApproval["prompt"]>];
          return typeof value === "string" ? [[field, value]] : [];
        }),
      )),
    }),
    consumed: false,
    audit: input.audit,
    beforeProvider: input.beforeProvider,
  });
  return true;
}

export function getLegacyToolApproval(input: { runId: string; requestId: string }) {
  if (closingRuns.has(input.runId)) return null;
  const registration = registrations.get(key(input.runId, input.requestId));
  if (!registration || registration.consumed) return null;
  return {
    companyId: registration.companyId,
    agentId: registration.agentId,
    provider: registration.approval.provider,
    providerRunId: registration.approval.providerRunId,
    requestId: registration.approval.requestId,
    prompt: registration.approval.prompt,
  };
}

/** Marks before I/O: an ambiguous provider delivery is never replayed. */
export async function resolveLegacyToolApproval(input: {
  runId: string;
  requestId: string;
  choice: "once" | "deny";
}): Promise<boolean> {
  if (closingRuns.has(input.runId)) return false;
  const registrationKey = key(input.runId, input.requestId);
  const registration = registrations.get(registrationKey);
  if (!registration || registration.consumed) return false;
  registration.consumed = true;
  consumedRequests.add(registrationKey);
  const event = Object.freeze({
    attemptId: randomUUID(), companyId: registration.companyId, runId: input.runId,
    provider: registration.approval.provider, providerRunId: registration.approval.providerRunId,
    requestId: registration.approval.requestId, choice: input.choice,
  });
  try {
    // Durable consumed evidence must precede ALL provider I/O. Failure never
    // restores the process-local grant, even when no POST was made.
    if (!registration.audit) throw new Error("legacy_consent_audit_unavailable");
    try { await registration.audit(Object.freeze({ ...event, phase: "attempt" })); }
    catch { throw new Error("legacy_consent_preaudit_failed_no_delivery"); }
    let cancellation: "cancel" | null = null;
    try { cancellation = await registration.beforeProvider?.() ?? null; }
    catch { cancellation = "cancel"; }
    const expired = registration.approval.expiresAt !== undefined &&
      (!Number.isFinite(registration.approval.expiresAt) || Date.now() >= registration.approval.expiresAt);
    if (expired || cancellation || closingRuns.has(input.runId) || registration.approval.isClosed?.()) {
      try {
        await registration.audit(Object.freeze({ ...event, phase: "outcome", outcome: expired ? "expired" : "cancel" }));
      } catch { throw new Error("legacy_consent_cancel_outcome_audit_failed_no_delivery"); }
      return false;
    }
    try { await registration.approval.resolve(input.choice); }
    catch {
      try { await registration.audit(Object.freeze({ ...event, phase: "outcome", outcome: "failed-or-unknown" })); }
      catch { /* The durable attempt remains evidence; never retry delivery. */ }
      throw new Error("legacy_consent_delivery_failed_or_unknown_no_retry");
    }
    try {
      await registration.audit(Object.freeze({ ...event, phase: "outcome", outcome: input.choice === "deny" ? "deny" : "resolved" }));
    } catch {
      throw new Error("legacy_consent_outcome_unknown_no_retry");
    }
    return true;
  } finally {
    registrations.delete(registrationKey);
  }
}

export async function clearLegacyToolApprovalsForRun(runId: string): Promise<void> {
  // Fence and consume ALL pending records synchronously, before first await.
  closingRuns.add(runId);
  const pending: Registration[] = [];
  for (const [registrationKey, registration] of registrations) {
    if (!registrationKey.startsWith(`${runId}\u0000`)) continue;
    registrations.delete(registrationKey);
    consumedRequests.add(registrationKey);
    if (!registration.consumed) {
      registration.consumed = true;
      pending.push(registration);
    }
  }
  const outcomes = await Promise.allSettled(pending.map(async registration => {
    if (!registration.audit) throw new Error("legacy_consent_audit_unavailable");
    const deadline = registration.approval.expiresAt;
    const expired = deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline);
    await registration.audit(Object.freeze({
      attemptId: randomUUID(), companyId: registration.companyId, runId,
      provider: registration.approval.provider, providerRunId: registration.approval.providerRunId,
      requestId: registration.approval.requestId, phase: "outcome", outcome: expired ? "expired" : "cancel",
    }));
  }));
  if (outcomes.some(outcome => outcome.status === "rejected")) {
    throw new Error("legacy_consent_withdrawal_audit_failed_no_delivery");
  }
}
