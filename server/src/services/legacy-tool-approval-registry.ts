import type { AdapterLegacyToolApproval } from "@paperclipai/adapter-utils";

type Registration = {
  companyId: string;
  agentId: string;
  approval: AdapterLegacyToolApproval;
  consumed: boolean;
};

const registrations = new Map<string, Registration>();
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
}): boolean {
  if (closingRuns.has(input.runId)) return false;
  const registrationKey = key(input.runId, input.approval.requestId);
  if (registrations.has(registrationKey)) return false;
  registrations.set(registrationKey, {
    companyId: input.companyId,
    agentId: input.agentId,
    approval: input.approval,
    consumed: false,
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
  try {
    await registration.approval.resolve(input.choice);
    return true;
  } finally {
    registrations.delete(registrationKey);
  }
}

export function clearLegacyToolApprovalsForRun(runId: string): void {
  closingRuns.add(runId);
  for (const registrationKey of registrations.keys()) {
    if (registrationKey.startsWith(`${runId}\u0000`)) registrations.delete(registrationKey);
  }
}
