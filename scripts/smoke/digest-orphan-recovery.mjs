#!/usr/bin/env node
// Offline source-execution seam: real recovery function, in-memory DB/deps.
// No adapter, API, network, or human interaction is started.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../../server/src/services/recovery/service.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async function reconcileUnassignedBlockingIssues() {');
const end = source.indexOf('\n  async function getCompanyIssuePrefix', start);
assert.ok(start >= 0 && end > start, 'recovery seam must exist');
// Strip only the two TS annotations; keep all recovery logic unchanged.
const body = source.slice(start, end)
  .replace('const issueIds: string[] = [];', 'const issueIds = [];')
  .replace('new Set<string>()', 'new Set()');
const input = JSON.parse(readFileSync(0, 'utf8'));
const ask = structuredClone(input.ask);
const origin = structuredClone(input.origin);
const calls = [];
const columns = new Proxy({}, { get: (_, name) => name });
const value = (field) => ask[field];
const sql = (strings) => {
  const text = strings.join('?');
  if (text.includes('createdByAgentId') || text.includes('is not null')) {
    if (!text.includes('exists')) return () => ask.createdByAgentId !== null;
  }
  if (text.includes('exists')) return () => !['done', 'cancelled'].includes(origin.status);
  throw new Error(`Unsupported SQL seam: ${text}`);
};
const ctx = createContext({
  Set, Date,
  issues: columns, issueRelations: columns,
  eq: (field, expected) => field === 'type' ? () => expected === 'blocks' : () => value(field) === expected,
  inArray: (field, expected) => () => expected.includes(value(field)),
  isNull: (field) => () => value(field) == null,
  and: (...conditions) => () => conditions.every((check) => check()), sql,
  db: { select: (projection) => ({ from: () => ({ innerJoin: () => ({ where: (predicate) =>
    Promise.resolve(predicate() ? [Object.fromEntries(Object.entries(projection).map(([key, field]) => [key, value(field)]))] : []) }) }) }) },
  getAgent: async (id) => ({ id, companyId: ask.companyId }),
  isAgentInvokable: async () => input.invokable !== false,
  formatIssueLinksForComment: () => '[ORIGIN-1]',
  issuesSvc: {
    getRelationSummaries: async () => ({ blocks: [origin] }),
    update: async (id, patch) => { calls.push({ type: 'update', id, patch }); Object.assign(ask, patch); return ask; },
    addComment: async (id, body) => { calls.push({ type: 'comment', id, body }); },
  },
  logActivity: async (_, activity) => { calls.push({ type: 'activity', source: activity.details.source }); },
  withRecoveryContext: (payload) => payload,
  deps: { enqueueWakeup: async (id, wake) => { calls.push({ type: 'wake', id, reason: wake.reason, payload: wake.payload, contextSnapshot: wake.contextSnapshot }); return { id: 'offline-run' }; } },
});
runInContext(body + '\nglobalThis.reconcile = reconcileUnassignedBlockingIssues;', ctx);
const result = await ctx.reconcile();
const wakes = calls.filter((call) => call.type === 'wake');
assert.equal(calls.filter((call) => call.type === 'interaction').length, 0);
assert.equal(origin.status, 'blocked');
assert.deepEqual(origin.blockedByIssueIds, [ask.id]);
if (input.expectPreserved) {
  assert.equal(result.assigned, 0, 'queued high ASK must not be assigned by orphan repair');
  assert.equal(wakes.length, 0, 'queued ASK must not produce an agent wake');
  assert.equal(ask.assigneeAgentId, null);
} else if (input.invokable !== false) {
  assert.equal(result.assigned, 1);
  assert.equal(ask.assigneeAgentId, ask.createdByAgentId);
  assert.equal(wakes[0].payload.mutation, 'unassigned_blocker_recovery');
} else {
  assert.equal(result.assigned, 0);
  assert.equal(wakes.length, 0);
}
process.stdout.write(JSON.stringify({ result, ask, origin, calls }) + '\n');
