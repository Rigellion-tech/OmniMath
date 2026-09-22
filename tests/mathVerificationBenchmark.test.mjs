import '../tests/helpers/noExternalNetwork.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { buildCorpus, CATEGORIES } from '../scripts/verification-benchmark/corpus.mjs';
import { auditExtraction, metrics, runBenchmark } from '../scripts/verification-benchmark/evaluate.mjs';
import * as oracle from '../scripts/verification-benchmark/oracle.mjs';
const corpus=buildCorpus();
const report=runBenchmark(corpus);

describe('deterministic mathematical calibration corpus',()=>{
  for(const row of report.rows) it(`${row.id}: ${row.name}`,()=>{
    assert.ok(row.expectedAllowedStates.includes(row.evidence.state),JSON.stringify({id:row.id,groundTruth:row.groundTruth,evidence:row.evidence}));
    if(row.expectedStatus==='mathematically_correct')assert.notEqual(row.evidence.state,'contradicted');
    if(['mathematically_incorrect','domain_invalid'].includes(row.expectedStatus))assert.notEqual(row.evidence.state,'verified');
    assert.ok(row.groundTruth.notes);assert.ok(row.problem);assert.ok(CATEGORIES.includes(row.category));
    if(row.origin.startsWith('fixture_derived'))assert.ok(row.provenance || row.groundTruth.parentId);
  });
  it('replays with identical evidence, samples, exclusions and extraction results',()=>assert.deepEqual(runBenchmark(),report));
  it('does not mutate the benchmark inputs',()=>assert.deepEqual(corpus,buildCorpus()));
  it('keeps every implemented category and explicit ground-truth class represented',()=>{
    assert.deepEqual(Object.keys(report.byCategory),CATEGORIES);
    assert.deepEqual(Object.keys(report.byGroundTruth).sort(),['domain_invalid','mathematically_correct','mathematically_incorrect','unsupported_ambiguous']);
    assert.equal(corpus.length,229);
    assert.equal(report.extraction.byOrigin.stored_provider_diagnostic.candidates,13);
  });
  it('keeps the critical precision gates at zero defects',()=>{
    assert.deepEqual(report.falseContradictions,[]);assert.deepEqual(report.falseVerified,[]);
    // Undefined precision remains null. More inconclusive results do not fail
    // a precision gate; the report makes their evidence coverage visible.
    if(report.overall.contradicted)assert.equal(report.overall.contradictionPrecision.value,1);
    if(report.overall.verified)assert.equal(report.overall.verifiedPrecision.value,1);
  });
  it('never promotes known tiny perturbations to proof',()=>{
    const deceptive=report.rows.filter(r=>r.mutationType==='constant_offset'&&r.groundTruth.exactResidual==='1/1000000000000');
    assert.ok(deceptive.length>0);
    assert.ok(deceptive.every(r=>r.evidence.state!=='verified'));
  });
});

describe('independent ground-truth certificates',()=>{
  it('derives exact coefficients, derivatives and integrals independently',()=>{
    assert.equal(oracle.textQ(oracle.integral(oracle.parsePolynomial('3*x^2+5*x-22'),oracle.q(-2),oracle.q(3))),'-125/2');
    assert.deepEqual(oracle.derivative(oracle.parsePolynomial('(2*x+1)^3')).map(oracle.textQ),['6','24','24']);
    assert.deepEqual(oracle.parsePolynomial('0.1+0.2').map(oracle.textQ),['3/10']);
    assert.throws(()=>oracle.parsePolynomial('1/0'));
    assert.throws(()=>oracle.parsePolynomial('sin(x)'));
  });
  it('recomputes every dense coefficient certificate without the verifier',()=>{
    const toQ=s=>{const [n,d='1']=s.split('/');return oracle.q(n,d);};
    for(const c of corpus.filter(c=>c.groundTruth.engine)) {
      const g=c.groundTruth;
      const regenerated=oracle.certificate(g.expectedCoefficients.map(toQ),g.actualCoefficients.map(toQ));
      assert.equal(regenerated.status,c.expectedStatus,c.id);
      assert.deepEqual(regenerated.differenceCoefficients,g.differenceCoefficients,c.id);
      for(const values of [g.expectedCoefficients,g.actualCoefficients])assert.ok(oracle.equal(oracle.parsePolynomial(oracle.expression(values.map(toQ))),values.map(toQ)));
    }
  });
  it('does not assume every attempted corruption is false',()=>{
    const neutral=corpus.filter(c=>c.mutationType==='sign_reversal'&&c.expectedStatus==='mathematically_correct');
    assert.equal(neutral.length,3);
    assert.ok(neutral.every(c=>c.claim.lower===c.claim.upper));
  });
  it('links metamorphic labels only to established correct parent references',()=>{
    for(const c of corpus.filter(c=>c.groundTruth.parentId)) {
      assert.equal(corpus.find(p=>p.id===c.groundTruth.parentId)?.expectedStatus,'mathematically_correct');
      assert.notEqual(c.groundTruth.exactResidual,'0');
    }
  });
});

describe('calibration metrics and extraction denominators',()=>{
  it('counts unknown truth conservatively and keeps unsupported false claims out of recall',()=>{
    const row=(state,expectedStatus,supportedFalse=false)=>({evidence:{state},expectedStatus,supportedFalse});
    const m=metrics([
      row('contradicted','mathematically_incorrect',true),row('contradicted','mathematically_correct'),row('contradicted','unsupported_ambiguous'),
      row('inconclusive','mathematically_incorrect',true),row('inconclusive','mathematically_incorrect'),
      row('verified','mathematically_correct'),row('verified','domain_invalid',true),
      row('numerically_supported','mathematically_correct'),row('numerically_supported','mathematically_incorrect'),row('numerically_supported','unsupported_ambiguous'),
    ]);
    assert.equal(m.contradictionPrecision.value,1/3);assert.equal(m.contradictionRecall.value,1/3);
    assert.equal(m.falseContradictionRate.value,1/3);assert.equal(m.verifiedPrecision.value,1/2);
    assert.equal(m.numericalSupportPrecision.value,1/3);assert.equal(m.inconclusiveRate.value,1/5);
    assert.equal(metrics([]).contradictionPrecision.value,null);
  });
  it('distinguishes an interpreted inconclusive claim from a skipped field',()=>{
    const r=auditExtraction([{id:'coverage',origin:'test',provenance:{},problem:String.raw`\int_0^1 x\,dx`,candidate:{steps:[{latex:'x=2'},{math:String.raw`\int_0^1 exp(-x^2)\,dx=2`}],finalAnswerLatex:'1/2',finalAnswer:'one half'}}]);
    assert.equal(r.summary.candidateFields,4);assert.equal(r.summary.examinedFields,3);
    assert.equal(r.summary.recognized,2);assert.equal(r.summary.skipped,2);
    assert.equal(r.summary.verified,1);assert.equal(r.summary.inconclusive,2);
    assert.deepEqual(r.rows[0].unexaminedFields,['finalAnswer']);
  });
  it('reports fields beyond the production budget and avoids counting the budget marker as a field',()=>{
    const r=auditExtraction([{id:'budget',origin:'test',provenance:{},problem:'x=1',candidate:{steps:Array.from({length:35},()=>({latex:'1=1'})),finalAnswerLatex:'x=1'}}]);
    assert.equal(r.summary.candidateFields,36);assert.equal(r.summary.examinedFields,32);
    assert.equal(r.summary.recognized,32);assert.equal(r.summary.skipped,4);
  });
  it('retains only math fields from provider diagnostics, with source hashes',()=>{
    const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/verification/solution-fields.json',import.meta.url),'utf8'));
    for(const f of fixtures.filter(f=>f.origin==='stored_provider_diagnostic')) {
      assert.match(f.provenance.sha256,/^[a-f0-9]{64}$/);
      assert.deepEqual(Object.keys(f.candidate).sort(),['finalAnswerLatex','steps']);
      for(const s of f.candidate.steps)assert.ok(Object.keys(s).every(k=>['id','math','latex','equationLatex'].includes(k)));
    }
  });
});
