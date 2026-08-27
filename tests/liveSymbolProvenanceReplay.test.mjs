import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeSymbolOrigins } from "../server/symbolInventory.js";
import { evaluateSolutionQualityRules } from "../server/solutionValidation.js";

const fixtureUrl = new URL("./fixtures/validation/live-symbol-provenance-replay.json", import.meta.url);

async function readFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function oneFieldCandidate(math = "") {
  return {
    title: "Observed symbol fragment",
    expression: "1",
    steps: [{ id: "s1", math, summary: "Replay the supplied math fragment." }],
    finalAnswerLatex: "1",
  };
}

test("live Terra/Sol symbol excerpts replay without provenance false positives", async () => {
  const fixture = await readFixture();
  const expectations = [
    ["namedIntegral", "I"],
    ["parameterDomain", "a"],
    ["parameterDomain", "b"],
    ["polylogarithmDefinition", "z"],
    ["derivativeVariable", "u"],
    ["fourierDomain", "y"],
  ];

  for (const [fragmentName, symbol] of expectations) {
    const analysis = analyzeSymbolOrigins("Evaluate 1.", oneFieldCandidate(
      fixture.observedFragments[fragmentName]
    ));
    assert.equal(analysis.unexplainedSymbols.includes(symbol), false, `${fragmentName}:${symbol}`);
  }
});

test("reconstructed Terra/Sol candidates retain numerical validation and need no provider call", async () => {
  const fixture = await readFixture();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider access is forbidden in deterministic validation replay tests.");
  };

  try {
    for (const candidate of fixture.candidates) {
      const report = evaluateSolutionQualityRules(candidate, { problem: fixture.problem.latex });

      assert.deepEqual(report.context.symbolOriginDiagnostics.unexplainedSymbols, [], candidate.modelRole);
      assert.equal(
        report.issues.some((issue) => issue.startsWith("unexplained_generated_symbol:")),
        false,
        candidate.modelRole
      );
      assert.equal(
        report.issues.includes("abrupt_special_function_introduction:polylogarithm"),
        false,
        candidate.modelRole
      );
      assert.equal(report.context.numericalCrossCheckResult.applicable, true, candidate.modelRole);
      assert.equal(report.context.numericalCrossCheckResult.issue, null, candidate.modelRole);
      assert.ok(
        Math.abs(
          report.context.numericalCrossCheckResult.proposedValue
          - fixture.problem.expectedNumericValue
        ) < 1e-12,
        candidate.modelRole
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(providerCalls, 0);
});

test("reconstructed rational v change of variable is introduced and propagated without a provider call", async () => {
  const fixture = await readFixture();
  const replay = fixture.currentVFailureReconstruction;
  const analysis = analyzeSymbolOrigins(replay.problem, replay.candidate);

  assert.equal(analysis.unexplainedSymbols.includes("v"), false);
  assert.ok(analysis.explicitDefinitions.includes("v"));
  const provenance = analysis.provenanceDiagnostics.find((record) => record.symbol === "v");
  assert.equal(provenance?.provenanceCategory, "substitution_variable");
  assert.equal(provenance?.introducedAt?.fieldPath, "steps[0].math");
  assert.equal(provenance?.scope, "persistent");
  assert.equal(analysis.fieldReports.find((field) => field.fieldPath === "steps[1].math")?.unexplainedSymbols.includes("v"), false);
});

test("provenance relaxations do not accept undefined symbols or an unintroduced Li2", async () => {
  const fixture = await readFixture();
  for (const math of ["I+1=2", "a+b=1", "z^2+1", "u+v", "y+1=4"]) {
    const analysis = analyzeSymbolOrigins("Evaluate 1.", oneFieldCandidate(math));
    assert.notDeepEqual(analysis.unexplainedSymbols, [], math);
  }

  const report = evaluateSolutionQualityRules({
    title: "Unintroduced polylogarithm",
    expression: fixture.problem.latex,
    steps: [
      {
        id: "s1",
        math: "I=\\operatorname{Li}_2(1/2)",
        summary: "Use a polylogarithm without defining it.",
      },
      {
        id: "s2",
        math: "I=\\frac{\\pi}{2}\\ln^2 2",
        summary: "State the proposed result.",
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
  }, { problem: fixture.problem.latex });

  assert.ok(report.issues.includes("abrupt_special_function_introduction:polylogarithm"));
});
