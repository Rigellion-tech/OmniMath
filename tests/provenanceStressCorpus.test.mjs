import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  provenanceFixtureById,
  provenanceStressCorpus,
} from "./fixtures/provenanceStressCorpus.mjs";

describe("deep explanation provenance stress corpus", () => {
  it("uses unique occurrence and step identities as deterministic oracles", () => {
    assert.equal(new Set(provenanceStressCorpus.map((fixture) => fixture.id)).size, provenanceStressCorpus.length);

    for (const fixture of provenanceStressCorpus) {
      const stepIds = new Set(fixture.steps.map((step) => step.id));
      assert.equal(stepIds.has(fixture.selected.stepId), true, `${fixture.id}: selected step`);
      assert.ok(fixture.selected.semanticId, `${fixture.id}: semantic id`);
      assert.ok(fixture.selected.occurrenceKey, `${fixture.id}: occurrence key`);
      assert.ok(fixture.selected.parentExpression, `${fixture.id}: parent expression`);
      fixture.dependencies.forEach((dependency) => {
        assert.equal(stepIds.has(dependency.stepId), true, `${fixture.id}: dependency ${dependency.id}`);
        assert.match(dependency.kind, /^(explicit|reconstructed|implicit|assumption|approximation|unknown)$/);
      });
    }
  });

  it("covers orthogonal provenance hazards and reasoning domains", () => {
    const hazards = new Set(provenanceStressCorpus.flatMap((fixture) => fixture.hazards));
    const domains = new Set(provenanceStressCorpus.map((fixture) => fixture.domain));

    [
      "repeated-text", "deep-chain", "branching", "implicit-rule", "skipped-step",
      "multi-turn", "pronoun-reference", "wrong-premise", "long-distance", "branches",
      "domain", "approximation", "missing-provenance", "uncertainty-required",
    ].forEach((hazard) => assert.equal(hazards.has(hazard), true, `missing hazard ${hazard}`));
    ["linear-algebra", "calculus", "algebra", "probability", "discrete-special", "mixed"]
      .forEach((domain) => assert.equal(domains.has(domain), true, `missing domain ${domain}`));
  });

  it("encodes the motivating matrix chain as a real 2x2 cofactor calculation", () => {
    const fixture = provenanceFixtureById["matrix-inverse-adjugate-entry"];
    const dependencies = new Set(fixture.dependencies.map((dependency) => dependency.id));

    assert.equal(fixture.selected.text, "20");
    assert.equal(fixture.selected.stepId, "s4");
    ["adjugate-position-22", "cofactor-22", "minor-22", "minor-determinant", "cofactor-sign"]
      .forEach((dependency) => assert.equal(dependencies.has(dependency), true));
    assert.match(fixture.steps.find((step) => step.id === "s3").math, /4·5−2·0=20/);
  });

  it("retains genuine 40-step distance and marks absent evidence as unknown", () => {
    const long = provenanceFixtureById["long-distance-chain-40"];
    const missing = provenanceFixtureById["insufficient-provenance"];

    assert.equal(long.steps.length, 42);
    assert.equal(long.dependencies.find((dependency) => dependency.id === "power").distance, 40);
    assert.equal(missing.dependencies[0].kind, "unknown");
    assert.equal(missing.requiredClaims.length, 0);
    assert.ok(missing.forbiddenClaims.length > 0);
  });
});
