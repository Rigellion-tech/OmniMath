import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeInternalTitle,
  userFacingText,
  userFacingTooltipTitle,
} from "../src/lib/presentationLabels.js";

describe("presentation labels", () => {
  it("maps known internal identity names to educational titles", () => {
    assert.equal(
      userFacingTooltipTitle({
        title: "CurlDivergenceIdentitySelfZeroCurl",
        selectedText: "\\nabla\\cdot(\\nabla\\times\\mathbf{F})",
      }),
      "Divergence of a Curl"
    );
    assert.equal(userFacingTooltipTitle({ title: "TrigPythagoreanIdentity" }), "Pythagorean Trigonometric Identity");
    assert.equal(userFacingTooltipTitle({ title: "IntegrationByPartsSelection" }), "Integration by Parts");
  });

  it("rejects internal labels and falls back to the selected token", () => {
    const title = userFacingTooltipTitle({
      title: "expression_with_identity_substitution_triggered_less_abstract_identity",
      selectedText: "\\nabla\\cdot(\\nabla\\times\\mathbf{F})",
    });

    assert.equal(title, "∇·(∇×F)");
    assert.equal(title.includes("_"), false);
    assert.equal(looksLikeInternalTitle("expression_with_identity_substitution_triggered_less_abstract_identity"), true);
    assert.equal(looksLikeInternalTitle("someReasoningKeyMetadata"), true);
  });

  it("keeps concise human titles and rejects fallback internal content", () => {
    assert.equal(userFacingTooltipTitle({ title: "Vector Calculus Identity" }), "Vector Calculus Identity");
    assert.equal(userFacingText("classifier_tag_for_prompt_debug", "Selected Token"), "Selected Token");
  });
});
