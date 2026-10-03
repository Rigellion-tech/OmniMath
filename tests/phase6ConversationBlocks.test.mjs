import assert from "node:assert/strict";
import test from "node:test";
import { conversationBlocks } from "../src/lib/conversationBlocks.js";

test("conversation headings and lists do not need separating blank lines", () => {
  assert.deepEqual(conversationBlocks("Reasoning first.\n### Example\nTry **this**.\n- Use $x$\n- Check $y$\n## Result\nDone").map((block) => block.type),
    ["paragraph", "heading", "paragraph", "list", "heading", "paragraph"]);
  assert.equal(conversationBlocks("### Example")[0].text, "Example");
});

test("multiline display math retains its exact source and gets a separate block", () => {
  const math = "\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}";
  const blocks = conversationBlocks(`Before\n\\[\n${math}\n\\]\nAfter`);
  assert.deepEqual(blocks, [{ type: "paragraph", text: "Before" }, { type: "math", text: math }, { type: "paragraph", text: "After" }]);
});

test("standalone inline expressions become display math without changing prose math", () => {
  const blocks = conversationBlocks("We use $x=1$ here.\n$\\frac{x}{y}=2$\n\\(y=3\\)");
  assert.equal(blocks[0].text, "We use $x=1$ here.");
  assert.deepEqual(blocks.slice(1), [{ type: "math", text: "\\frac{x}{y}=2" }, { type: "math", text: "y=3" }]);
});

test("unfinished display blocks retain partial text until streaming completes", () => {
  assert.deepEqual(conversationBlocks("### Derivation\n$$x ="), [{ type: "heading", text: "Derivation" }, { type: "paragraph", text: "$$x =" }]);
  assert.deepEqual(conversationBlocks("### Derivation\n$$x = 1$$\nFinished"), [{ type: "heading", text: "Derivation" }, { type: "math", text: "x = 1" }, { type: "paragraph", text: "Finished" }]);
});

test("numbered lists preserve starting number, order, and separate following prose", () => {
  assert.deepEqual(conversationBlocks("3. First\n4. Second\nExplanation"), [{ type: "ordered-list", items: ["First", "Second"], start: 3 }, { type: "paragraph", text: "Explanation" }]);
});
