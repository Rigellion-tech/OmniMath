import test from "node:test";
import assert from "node:assert/strict";
import { createProgressiveJsonFramer } from "../server/progressiveJsonFramer.js";
import { createProgressiveStepValidator } from "../server/progressiveStepValidation.js";

const step = (id, latex = "x=1") => ({ id, heading: `Solve ${id}`, latex,
  reasoning: "Apply the stated equality.", anchors: [] });
const solve = (steps = [step("s1"), step("s2", "x=2")]) => ({
  title: "Example", problemLatex: "x+1=2", steps,
  finalAnswerLatex: "x=1", numericCheck: "1+1=2",
});

test("fragmented provider JSON emits closed metadata, steps, and answer in order", () => {
  const json = JSON.stringify(solve([step("s1", "\\frac{1}{2}"), step("s2", "x+\\text{a}={2}")]));
  const framer = createProgressiveJsonFramer();
  const records = [];
  for (const char of json) records.push(...framer.push(char));
  assert.deepEqual(records.map((r) => r.type), ["metadata", "step", "step", "final_answer"]);
  assert.deepEqual(records.filter((r) => r.type === "step").map((r) => r.index), [0, 1]);
  assert.deepEqual(framer.finish(), JSON.parse(json));
});

test("one provider chunk can frame several complete records", () => {
  const framer = createProgressiveJsonFramer();
  assert.deepEqual(framer.push(JSON.stringify(solve())).map((r) => r.type),
    ["metadata", "step", "step", "final_answer"]);
  assert.equal(framer.finish().steps.length, 2);
});

test("incomplete step remains transient and finalization fails", () => {
  const framer = createProgressiveJsonFramer();
  const json = JSON.stringify(solve());
  const partial = json.slice(0, json.indexOf('"reasoning"') + 9);
  assert.deepEqual(framer.push(partial).map((r) => r.type), ["metadata"]);
  assert.throws(() => framer.finish(), /Incomplete/);
});

test("malformed completed JSON and output limits fail closed", () => {
  const framer = createProgressiveJsonFramer();
  assert.throws(() => framer.push('{"title":"x","problemLatex":"y","steps":[{"id":"s1",}]}'),
    /Invalid completed step JSON/);
  assert.throws(() => createProgressiveJsonFramer({ maxChars: 4 }).push("12345"), /limit/);
});

test("validator accepts immutable canonical steps with server authority", () => {
  const validator = createProgressiveStepValidator({ sourceHash: "hash-1" });
  const first = validator.accept(step("s1"), { stepIndex: 0, sourceHash: "hash-1" });
  assert.equal(first.validation.status, "accepted");
  assert.equal(first.step.math, "x=1");
  assert.ok(first.step.chunks[0].display);
  assert.ok(Object.isFrozen(first.step));
  assert.ok(Object.isFrozen(first.step.chunks[0]));
  validator.accept(step("s2", "x=2"), { stepIndex: 1, sourceHash: "hash-1" });
  assert.equal(validator.assertPrefix(solve()), true);
  assert.throws(() => validator.assertPrefix(solve([step("s1", "x=3"), step("s2", "x=2")])),
    /completed_prefix_mutated/);
});

test("validator rejects invalid, duplicate, conflicting, and out-of-order steps", () => {
  const validator = createProgressiveStepValidator({ sourceHash: "hash-1" });
  const accept = (value, index = 0, hash = "hash-1") =>
    validator.accept(value, { stepIndex: index, sourceHash: hash });
  assert.throws(() => accept(step("s1"), 0, "wrong"), /source_identity_mismatch/);
  assert.throws(() => accept({ ...step("s1"), draft: "partial" }), /invalid_shape/);
  assert.throws(() => accept(step("s1", "\\frac{1}{")), /invalid_latex/);
  assert.throws(() => accept(step("s1", "x+")), /obvious_truncation/);
  assert.throws(() => accept(step("s2"), 1), /out_of_order/);
  accept(step("s1"));
  assert.throws(() => accept(step("s1")), /duplicate_or_conflicting_step/);
  assert.throws(() => accept(step("s1", "x=5")), /duplicate_or_conflicting_step/);
  assert.throws(() => accept(step("s1"), 1), /duplicate_or_invalid_id/);
  assert.equal(validator.acceptedCount, 1);
});
