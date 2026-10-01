import { describe, expect, it } from "vitest";
import { upsertBudgetPolicySchema } from "./budget.js";

// A policy row created without an explicit `hardStopEnabled` must not arm a
// hard stop: the budget lives on as a soft/warn policy until someone turns the
// hard stop on deliberately. Regression: new agents and projects used to get
// `hardStopEnabled: true` back as a side effect of the create path.
describe("budget policy validators", () => {
  const basePolicy = {
    scopeType: "agent",
    scopeId: "11111111-1111-4111-8111-111111111111",
    amount: 5_000,
  } as const;

  it("defaults a new policy to hard stop off", () => {
    expect(upsertBudgetPolicySchema.parse({ ...basePolicy }).hardStopEnabled).toBe(false);
  });

  it("keeps an explicit hard stop on when the caller asks for it", () => {
    expect(
      upsertBudgetPolicySchema.parse({ ...basePolicy, hardStopEnabled: true }).hardStopEnabled,
    ).toBe(true);
    expect(
      upsertBudgetPolicySchema.parse({ ...basePolicy, hardStopEnabled: false }).hardStopEnabled,
    ).toBe(false);
  });
});
