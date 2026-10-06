# Pending Review Recovery Implementation Plan

**Goal:** Recover the existing CRE1292 pending review without a duplicate interaction or ownership transfer, then verify the exact deployed artifact and continue the original delivery pilot.

**Architecture:** Add an explicit optional pendingInteraction selector to the modern wake API. Normal actor/agent and issue permissions remain mandatory. The server loads and validates current issue, interaction, resolver audience and target, constructs canonical context with distinct recovery provenance, then uses unchanged queued/final participation gates. No caller authority markers or old creator impersonation.

- [x] Add HTTP regression reproducing absent interaction scope; observe RED.
- [x] Add database-backed selector positives and negatives; preserve history and ownership.
- [x] Implement scoped selector, schema and operation documentation; observe GREEN.
- [x] Reproduce independent dedup finding with integrated enqueue RED; reserve/replay durable identity and verify concurrent, deferred and ended-run retries GREEN.
- [ ] Independent exact-head review, native CI, source integration and immutable runtime smoke.
- [ ] Normal release pin/deploy; recover existing25ff interaction once with stable request key.
- [ ] Verify actual review/parent integration, original and negative scenarios, and complete remaining full-goal pilot requirements without CRE787 bypass.
