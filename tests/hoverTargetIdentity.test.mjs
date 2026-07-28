import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStableLazyPayload,
  createSemanticIdentity,
  getHoverTargetIdentity,
  isValidHoverTarget,
  resolveLazyExplanationForTarget,
  shouldApplyLazyExplanation,
} from "../src/lib/hoverTargetIdentity.js";
import { cleanSemanticTarget } from "../src/lib/mathHitboxes.js";
import { createRangeSelection } from "../src/lib/mathSelectionModel.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { userFacingTooltipTitle } from "../src/lib/presentationLabels.js";

const numberTarget = {
  id: "chunk-number-18pi",
  referenceId: "node-final-number-18pi",
  stepId: "step-final",
  title: "number",
  selectedText: "18\\pi",
  display: "18\\pi",
  latex: "18\\pi",
  role: "number",
  selectedTokens: [{
    id: "node-final-number-18pi",
    role: "number",
    sourceRange: { start: 42, end: 47 },
  }],
};

describe("hover target identity", () => {
  it("keeps a valid 18pi leaf target stable after async explanation resolves", () => {
    const resolved = resolveLazyExplanationForTarget({
      title: "Whole equation",
      explanation: "Model text may mention the equation, but the target stays the leaf.",
    }, numberTarget);

    assert.equal(getHoverTargetIdentity(numberTarget).targetId, "node-final-number-18pi");
    assert.equal(resolved.title, "18π");
    assert.equal(resolved.targetId, "node-final-number-18pi");
    assert.equal(shouldApplyLazyExplanation(numberTarget, resolved), true);
  });

  it("preserves lazy explanation text length through target resolution", () => {
    const explanation = "A long explanation with inline math x^2 + y^2 and enough text to catch truncation.";
    const resolved = resolveLazyExplanationForTarget({
      title: "Whole equation",
      explanation,
    }, numberTarget);

    assert.equal(resolved.explanation.length, explanation.length);
    assert.equal(resolved.explanation, explanation);
  });

  it("keeps hovering 18 inside 18pi from escalating to the whole equation", () => {
    const eighteenTarget = {
      ...numberTarget,
      referenceId: "node-final-number-18",
      selectedText: "18",
      display: "18",
      latex: "18",
      selectedTokens: [{ id: "node-final-number-18", role: "number", display: "18", latex: "18", sourceRange: { start: 42, end: 44 } }],
    };
    const parentEquation = {
      id: "equation",
      display: "x=18\\pi",
      latex: "x=18\\pi",
      role: "equation",
    };
    const target = cleanSemanticTarget(
      eighteenTarget.selectedTokens[0],
      new Map([[parentEquation.id, parentEquation], [eighteenTarget.selectedTokens[0].id, eighteenTarget.selectedTokens[0]]]),
      parentEquation
    );

    assert.equal(target.id, "node-final-number-18");
    assert.equal(resolveLazyExplanationForTarget({ title: "Equation" }, eighteenTarget).title, "18");
  });

  it("ignores stale hover explanation responses for an older target", () => {
    const newerTarget = {
      ...numberTarget,
      referenceId: "node-final-pi",
      selectedText: "\\pi",
      display: "\\pi",
      latex: "\\pi",
      selectedTokens: [{ id: "node-final-pi", role: "constant", sourceRange: { start: 44, end: 47 } }],
    };
    const oldResolved = resolveLazyExplanationForTarget({ explanation: "old" }, numberTarget);

    assert.equal(shouldApplyLazyExplanation(newerTarget, oldResolved), false);
  });

  it("adds target identity to lazy explanation payloads", () => {
    const payload = createStableLazyPayload(numberTarget, {
      selectedLatex: numberTarget.selectedText,
      stepId: numberTarget.stepId,
    });

    assert.equal(payload.targetId, "node-final-number-18pi");
    assert.equal(payload.semanticId, "node-final-number-18pi");
    assert.equal(payload.tooltipSemanticId, "node-final-number-18pi");
    assert.equal(payload.targetLabel, "18π");
    assert.equal(payload.targetRole, "number");
    assert.deepEqual(payload.targetSourceRange, { start: 42, end: 47 });
    assert.deepEqual(payload.selectedNode, {
      id: "node-final-number-18pi",
      semanticNodeId: "node-final-number-18pi",
      type: "number",
      role: "number",
      aggregate: false,
      leaf: true,
      childIds: [],
      source: "18\\pi",
      normalizedSource: "18\\pi",
      start: 42,
      end: 47,
      sourceRange: { start: 42, end: 47 },
    });
  });

  it("preserves aggregate semantic payload identity and source ranges", () => {
    const aggregate = {
      id: "integral-full",
      semanticNodeId: "integral-full",
      type: "integral",
      role: "integral",
      latex: "\\int_0^{\\pi/2}\\sin x\\,dx",
      display: "\\int_0^{\\pi/2}\\sin x\\,dx",
      sourceRange: { start: 0, end: 28 },
      childIds: ["upper", "integrand", "dx"],
      stepId: "step-1",
    };
    const payload = createStableLazyPayload(aggregate, {
      selectedLatex: aggregate.latex,
      stepLatex: aggregate.latex,
    });

    assert.equal(payload.semanticId, "integral-full");
    assert.equal(payload.selectedLatex, aggregate.latex);
    assert.equal(payload.selectedNode.id, "integral-full");
    assert.equal(payload.selectedNode.type, "integral");
    assert.equal(payload.selectedNode.aggregate, true);
    assert.equal(payload.selectedNode.leaf, false);
    assert.deepEqual(payload.selectedNode.sourceRange, { start: 0, end: 28 });
    assert.deepEqual(payload.targetSourceRange, { start: 0, end: 28 });
  });

  it("preserves aggregate metadata carried by the hover-window selected token", () => {
    const aggregate = {
      id: "integral-full",
      semanticNodeId: "integral-full",
      type: "integral",
      role: "integral",
      latex: "\\int_0^{\\pi/2}\\sin x\\,dx",
      source: "\\int_0^{\\pi/2}\\sin x\\,dx",
      normalizedSource: "\\int_0^{\\pi/2}\\sin x\\,dx",
      sourceRange: { start: 0, end: 28 },
      childIds: ["lower-bound", "upper-bound", "integrand", "differential"],
      aggregate: true,
      leaf: false,
      stepId: "step-1",
    };
    const hoverWindow = {
      id: "chunk-integral-full-123",
      referenceId: aggregate.id,
      referenceType: "token",
      stepId: aggregate.stepId,
      selectedText: aggregate.latex,
      display: aggregate.latex,
      selectedTokens: [aggregate],
      semanticIdentity: createSemanticIdentity({
        ...aggregate,
        selectedText: aggregate.latex,
      }),
    };
    const payload = createStableLazyPayload(hoverWindow, {
      selectedLatex: aggregate.latex,
      stepLatex: aggregate.latex,
      stepId: aggregate.stepId,
    });

    assert.equal(payload.selectedNode.id, aggregate.id);
    assert.equal(payload.selectedNode.role, "integral");
    assert.equal(payload.selectedNode.aggregate, true);
    assert.equal(payload.selectedNode.leaf, false);
    assert.deepEqual(payload.selectedNode.childIds, aggregate.childIds);
    assert.deepEqual(payload.selectedNode.sourceRange, aggregate.sourceRange);
  });

  it("sends frontend-resolved selected node and ancestors to the explanation API", () => {
    const target = {
      id: "pow-exp-two",
      semanticNodeId: "pow-exp-two",
      stepId: "step-integral",
      type: "number",
      kind: "number",
      role: "exponent",
      latex: "2",
      source: "2",
      normalizedSource: "2",
      sourceRange: { start: 21, end: 22 },
      ancestors: [
        { id: "power-x2", type: "power", role: "power", source: "x^2", sourceRange: { start: 19, end: 22 } },
        { id: "sum-1-x2", type: "sum", role: "argument", source: "1+x^2", sourceRange: { start: 17, end: 22 } },
      ],
    };
    const payload = createStableLazyPayload(target, {
      selectedLatex: "2",
      stepId: target.stepId,
      stepLatex: "\\int_0^\\infty...",
    });

    assert.equal(payload.selectedNode.id, "pow-exp-two");
    assert.equal(payload.selectedNode.role, "exponent");
    assert.deepEqual(payload.selectedNode.sourceRange, { start: 21, end: 22 });
    assert.deepEqual(payload.ancestors.map((ancestor) => ancestor.id), ["power-x2", "sum-1-x2"]);
    assert.equal(payload.ancestors[0].source, "x^2");
  });

  it("rejects lazy responses whose echoed semantic id differs from the selected target", () => {
    const selected = {
      ...numberTarget,
      semanticIdentity: createSemanticIdentity(numberTarget),
    };
    const resolved = resolveLazyExplanationForTarget({
      semanticId: "different-node",
      targetId: "different-node",
      explanation: "wrong target",
    }, selected);

    assert.equal(resolved.targetId, "different-node");
    assert.equal(shouldApplyLazyExplanation(selected, resolved), false);
  });

  it("uses selected semantic ranges as explanation targets instead of the nearest leaf", () => {
    const tree = buildSemanticTree({
      stepId: "imaginary-step",
      displayLatex: "x=(-35\\pm i\\sqrt{278471})/6",
      enabled: true,
    });
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const imaginary = leaves.find((node) => node.latex === "i");
    const radicand = leaves.find((node) => node.latex === "278471");
    const semanticSelection = createRangeSelection(tree, imaginary.id, radicand.id);
    const selectionItem = {
      id: semanticSelection.id,
      referenceId: semanticSelection.id,
      referenceType: "selection",
      stepId: tree.stepId,
      title: "Selected region",
      selectedText: semanticSelection.selectedText,
      display: semanticSelection.selectedText,
      selectedTokens: semanticSelection.leafIds.map((id) => tree.nodeMap[id]),
      semanticSelection,
      context: { semanticSelection },
    };
    const identity = getHoverTargetIdentity(selectionItem);
    const payload = createStableLazyPayload(selectionItem, {
      selectedLatex: selectionItem.selectedText,
      stepId: tree.stepId,
    });

    assert.equal(semanticSelection.normalizedToNodeId, tree.flatNodes.find((node) => node.latex === "i\\sqrt{278471}").id);
    assert.equal(identity.targetId, semanticSelection.id);
    assert.notEqual(identity.targetId, imaginary.id);
    assert.equal(payload.targetId, semanticSelection.id);
    assert.deepEqual(payload.semanticSelection.leafIds, semanticSelection.leafIds);
    assert.equal(shouldApplyLazyExplanation(selectionItem, resolveLazyExplanationForTarget({ explanation: "selected" }, selectionItem)), true);
  });

  it("keeps the signed exponent -1 identity out of the neighboring secant fraction", () => {
    const tree = buildSemanticTree({
      stepId: "signed-exponent-step",
      displayLatex: "(\\sec^2\\theta)^{a-1}\\frac{\\sec^2\\theta}{\\sec^2\\theta}",
      enabled: true,
    });
    const signedOne = tree.flatNodes.find((node) => node.latex === "-1" && node.role === "constant");
    const fraction = tree.flatNodes.find((node) => node.type === "fraction");
    assert.ok(signedOne?.id, "expected signed -1 semantic node");
    assert.ok(fraction?.id, "expected neighboring secant fraction");
    assert.notEqual(signedOne.id, fraction.id);

    const target = {
      ...signedOne,
      id: signedOne.id,
      semanticNodeId: signedOne.id,
      stepId: tree.stepId,
      selectedText: signedOne.latex,
      display: signedOne.latex,
      latex: signedOne.latex,
      source: signedOne.latex,
      normalizedSource: signedOne.latex,
      parentExpression: tree.displayLatex,
      selectedTokens: [signedOne],
      ancestors: [{
        id: signedOne.parentId,
        semanticNodeId: signedOne.parentId,
        type: tree.nodeMap[signedOne.parentId]?.type,
        role: tree.nodeMap[signedOne.parentId]?.role,
        source: tree.nodeMap[signedOne.parentId]?.latex,
        sourceRange: tree.nodeMap[signedOne.parentId]?.sourceRange,
      }],
    };
    const identity = createSemanticIdentity(target);
    const payload = createStableLazyPayload(target, {
      selectedLatex: target.selectedText,
      stepId: tree.stepId,
      stepLatex: tree.displayLatex,
    });
    const resolved = resolveLazyExplanationForTarget({
      semanticId: signedOne.id,
      targetId: signedOne.id,
      title: "Signed exponent",
      explanation: "The selected exponent offset is -1.",
    }, target);

    assert.equal(identity.targetId, signedOne.id);
    assert.equal(identity.sourceText, "-1");
    assert.deepEqual(identity.sourceRange, signedOne.sourceRange);
    assert.equal(payload.semanticId, signedOne.id);
    assert.equal(payload.targetId, signedOne.id);
    assert.equal(payload.selectedLatex, "-1");
    assert.equal(payload.selectedNode.id, signedOne.id);
    assert.equal(payload.selectedNode.source, "-1");
    assert.deepEqual(payload.selectedNode.sourceRange, signedOne.sourceRange);
    assert.equal(payload.selectedLatex.includes("\\frac"), false);
    assert.equal(shouldApplyLazyExplanation(target, resolved), true);
  });

  it("falls back to parent only for invalid child labels", () => {
    const validLeaf = { id: "leaf", display: "18", latex: "18", role: "number", parentId: "parent" };
    const invalidLeaf = { id: "bad", display: "()", latex: "()", role: "operator", parentId: "parent" };
    const parent = { id: "parent", display: "x=18\\pi", latex: "x=18\\pi", role: "equation" };
    const targetById = new Map([[validLeaf.id, validLeaf], [invalidLeaf.id, invalidLeaf], [parent.id, parent]]);

    assert.equal(cleanSemanticTarget(validLeaf, targetById, parent).id, "leaf");
    assert.equal(cleanSemanticTarget(invalidLeaf, targetById, parent).id, "parent");
    assert.equal(isValidHoverTarget(numberTarget), true);
  });

  it("prefers selected math over generic semantic titles", () => {
    assert.equal(userFacingTooltipTitle({
      title: "number",
      selectedText: "18\\pi",
      display: "18\\pi",
      latex: "18\\pi",
      role: "number",
    }), "18π");
  });
});
