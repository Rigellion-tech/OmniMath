import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {serializePrimaryComposer, restorePrimaryComposerSource} from '../src/lib/primaryComposerSerialization.js';
import {createCanonicalProblemPayload} from '../src/lib/canonicalProblem.js';
import {graduateExpressions} from './fixtures/composer/graduateExpressions.mjs';

for (const [name, latex] of graduateExpressions) {
  test(`${name}: authoritative source serializes deterministically through canonical payload and restore`, () => {
    const state = {prose: 'Find the result, giving all assumptions.', visualLatex: latex};
    const output = serializePrimaryComposer(state);
    const payload = {...createCanonicalProblemPayload({...output, source:'typed'}), composerSourceMode:'visual'};
    const restored = restorePrimaryComposerSource({canonicalProblem:payload});
    assert.deepEqual(serializePrimaryComposer(restored), output);
    assert.equal(createCanonicalProblemPayload({...serializePrimaryComposer(restored), source:'typed'}).hash, payload.hash);
    assert.equal(payload.canonicalText, `${state.prose}\n\n${latex}`);
  });
}
test('custom raw source never substitutes the old visual draft', () => {
  const rawLatex = String.raw`\specialOperator{A}_{\customIndex}`;
  const source = serializePrimaryComposer({sourceMode:'raw', rawLatex, visualLatex:'old'});
  const restored = restorePrimaryComposerSource({canonicalProblem:{...createCanonicalProblemPayload(source), composerSourceMode:'raw'}});
  assert.equal(restored.sourceMode,'raw');
  assert.equal(serializePrimaryComposer(restored).canonicalLatex,rawLatex);
});
test('typed prose-only problems reopen as editable prose; OCR source remains external context', () => {
  assert.equal(restorePrimaryComposerSource({canonicalProblem:{source:'typed', canonicalText:'Prove this theorem.'}}).prose,'Prove this theorem.');
  const ocr = restorePrimaryComposerSource({canonicalProblem:{source:'ocr-reviewed',canonicalText:'Reviewed text',canonicalLatex:'x^2'}});
  assert.equal(ocr.visualLatex,'');
  assert.equal(ocr.submitted.canonicalText,'Reviewed text');
});
test('secondary inputs do not import any primary editing subsystem', async () => {
  const secondary = await readFile(new URL('../src/components/math/ExplanationPanel.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(secondary,/PrimaryMathComposer|VisualMathField|MathInputPalette|mathlive/);
  const home = await readFile(new URL('../src/pages/Home.jsx',import.meta.url),'utf8');
  assert.match(home,/<PrimaryMathComposer/);
  assert.doesNotMatch(home,/usageBadges|fetchUsageSnapshot/);
});
