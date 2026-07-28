import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGeneratedProblemStatus } from "../src/lib/generationStatus.js";

describe("generated problem status", () => {
  it("does not report Explanation ready unless solution steps are present", () => {
    const status = getGeneratedProblemStatus({}, { title: "Solved", steps: [] });

    assert.equal(status.type, "error");
    assert.equal(status.label, "No solution steps returned");
    assert.notEqual(status.label, "Explanation ready");
  });

  it("reports a saved-warning status without hiding solved steps", () => {
    const status = getGeneratedProblemStatus(
      { runtime: { saveWarning: "auth_expired" } },
      { steps: [{ id: "s1", label: "Step 1" }] }
    );

    assert.equal(status.type, "warning");
    assert.equal(status.label, "Solved but not saved");
    assert.equal(status.detail, "1 step generated");
  });
});
