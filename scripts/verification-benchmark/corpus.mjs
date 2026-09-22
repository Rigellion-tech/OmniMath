import fs from 'node:fs';
import assert from 'node:assert/strict';
import { SOLVER_BENCHMARK_SUITES } from '../../server/solverBenchmarkSuite.js';
import * as o from './oracle.mjs';
const reference=JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/verification/reference-claims.json',import.meta.url),'utf8'));
export const CATEGORIES=['algebra','numerical_comparison','derivative','antiderivative','definite_integral','root_substitution','domain_reasoning'];
const CORRECT=['verified','numerically_supported','inconclusive'];
const FALSE=['contradicted','inconclusive','numerically_supported'];
export function buildCorpus() {
  const cases=[];
  function put(c) {
    const expectedStatus=c.groundTruth.status;
    cases.push({schemaVersion:1,assumptions:[],mutationType:null,supportedFalse:false,options:{},...c,expectedStatus,expectedAllowedStates:c.expectedAllowedStates || (expectedStatus==='mathematically_correct'?CORRECT:expectedStatus==='unsupported_ambiguous'?['inconclusive']:FALSE)});
  }
  const domainNames=new Set(['cancellation requires domain','nonzero denominator inferred','square root branch','log branch unknown','inverse branch','fractional powers no unsafe rewrite','power needs domain','zero times undefined','zero denominator never proved','pole introduced by multiplying','root outside sqrt domain','root outside log domain']);
  const invalidNames=new Set(['cancellation requires domain','log branch unknown','power needs domain','zero times undefined','zero denominator never proved','pole introduced by multiplying','root outside sqrt domain','root outside log domain']);
  const correctInconclusive=new Set(['square-root differentiability boundary']);
  const ambiguous=new Set(['numerical Gaussian','no approximate constant proof','numerical disagreement is not certified quadrature','absolute value unsupported','improper limits unsupported']);
  for(const [i,r] of reference.entries()) {
    const kind=r.integrand!==undefined?(r.lower!==undefined?'definite_integral':'antiderivative'):r.value!==undefined?'solution':r.expression!==undefined?'derivative':'equivalence';
    const fields=Object.fromEntries(['left','right','integrand','lower','upper','value','expression'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
    let status=r.state==='verified'||r.state==='numerically_supported'||correctInconclusive.has(r.name)?'mathematically_correct':r.state==='contradicted'?'mathematically_incorrect':'unsupported_ambiguous';
    if(invalidNames.has(r.name))status='domain_invalid';
    if(ambiguous.has(r.name))status='unsupported_ambiguous';
    // Approximate decimal reference values have no exact ground truth. Keep
    // their evidence visible, but exclude them from known-correct numerators.
    const allowed=['numerical Gaussian','no approximate constant proof'].includes(r.name)?['inconclusive','numerically_supported']:undefined;
    const category=domainNames.has(r.name)?'domain_reasoning':kind==='equivalence'?(/sin|cos|pi/.test(fields.left)?'numerical_comparison':'algebra'):kind==='solution'?'root_substitution':kind;
    put({id:`reference-${i}`,name:r.name,origin:'existing_verifier_reference',provenance:{path:r.path,line:r.line,sha256:r.sha256},problem:JSON.stringify(fields),claim:{kind,...fields,...(kind!=='equivalence'?{variable:'x'}:{})},category,groundTruth:{status,basis:'pre-existing explicit regression assertion; not the current verifier output',sourceAssertion:r.name,notes:status==='unsupported_ambiguous'?'No independently established exact truth; retain as abstention/coverage case.':`Inherited source assertion: ${r.name}. Domain-invalid means the claim is not defined throughout the unrestricted real domain.`},expectedAllowedStates:allowed,supportedFalse:r.state==='contradicted',mutationType:r.state==='contradicted'?'existing_corruption':null});
  }
  function polynomialCase(id,category,claim,expected,actual,extra={}) {
    const cert=o.certificate(expected,actual);
    put({id,name:id,origin:'synthetic_exact_oracle',problem:JSON.stringify(claim),category,claim,groundTruth:{...cert,notes:'Exact independent coefficient arithmetic determines the label before calling the verifier.'},supportedFalse:cert.status==='mathematically_incorrect',...extra});
  }
  // Source coefficients are taken from the existing solver benchmark, with
  // syntax converted only by explicit multiplication before independent parsing.
  const seeds=SOLVER_BENCHMARK_SUITES['advanced-math'].filter(s=>['linear-equation','quadratic-two-roots','perfect-square-root'].includes(s.id));
  for(const seed of seeds) {
    const source=seed.canonicalLatex.split('=')[0].replaceAll(/(\d)x/g,'$1*x');
    const p=o.parsePolynomial(source);
    const provenance={path:'server/solverBenchmarkSuite.js',caseId:seed.id,canonicalLatex:seed.canonicalLatex};
    const extra={origin:'fixture_derived_exact_oracle',provenance};
    const alternatives=[['expanded',p],['sign_flip',o.scale(p,o.q(-1))],['missing_term',p.map((c,i)=>i===0?o.q(0):c)],['changed_coefficient',o.plus(p,o.vector([0,1]))],['changed_exponent',[o.q(0),...p]]];
    for(const [mutation,answer] of alternatives) polynomialCase(`${seed.id}-algebra-${mutation}`,'algebra',{kind:'equivalence',left:source,right:o.expression(answer)},p,answer,{...extra,mutationType:mutation==='expanded'?null:mutation});
    const d=o.derivative(p);
    for(const [mutation,answer] of [['correct',d],['wrong_sign',o.scale(d,o.q(-1))],['missing_coefficient',o.scale(d,o.q(1,2))],['incorrect_power',[o.q(0),...d]]]) polynomialCase(`${seed.id}-derivative-${mutation}`,'derivative',{kind:'derivative',expression:source,right:o.expression(answer),variable:'x'},d,answer,{...extra,mutationType:mutation==='correct'?null:mutation});
    const primitive=o.primitive(p);
    for(const [mutation,answer] of [['correct',primitive],['missing_factor',o.scale(primitive,o.q(2))],['wrong_sign',o.scale(primitive,o.q(-1))],['incorrect_exponent',[o.q(0),...primitive]]]) polynomialCase(`${seed.id}-antiderivative-${mutation}`,'antiderivative',{kind:'antiderivative',integrand:source,right:o.expression(answer),variable:'x'},p,o.derivative(answer),{...extra,mutationType:mutation==='correct'?null:mutation});
    for(const [lo,hi] of [[0,1],[-2,3],[3,-2],[2,2]]) {
      const answer=o.integral(p,o.q(lo),o.q(hi));
      const alternatives=[['correct',answer],['sign_reversal',o.neg(answer)],['dropped_factor',o.mul(answer,o.q(1,2))],['perturbed_value',o.add(answer,o.q(1,100000))],['wrong_endpoint',o.integral(p,o.q(lo),o.q(hi+1))]];
      for(const [mutation,a] of alternatives) polynomialCase(`${seed.id}-integral-${lo}-${hi}-${mutation}`,'definite_integral',{kind:'definite_integral',integrand:source,lower:String(lo),upper:String(hi),right:o.textQ(a),variable:'x'},[answer],[a],{...extra,mutationType:mutation==='correct'?null:mutation});
    }
    const roots=seed.id==='linear-equation'?[-1225]:seed.id==='perfect-square-root'?[-44]:[2,o.q(-11,3)];
    for(const [i,root] of roots.entries()) {
      const r=Array.isArray(root)?root:o.q(root);assert.equal(o.evaluate(p,r)[0],0n);
      for(const [mutation,value] of [['correct',r],['sign_changed_root',o.neg(r)],['nearby_rational',o.add(r,o.q(1,1000))],['invalid_root',o.add(r,o.q(1))]]) polynomialCase(`${seed.id}-root-${i}-${mutation}`,'root_substitution',{kind:'solution',left:source,right:'0',value:o.textQ(value),variable:'x'},[o.q(0)],[o.evaluate(p,value)],{...extra,mutationType:mutation==='correct'?null:mutation});
    }
  }
  // Polynomial composition exercises the chain rule using independently
  // convolved coefficients; neither oracle labels nor candidates use verifier d().
  for(const [a,b,n] of [[2,1,3],[-3,2,4],[5,-2,2]]) {
    const inner=o.vector([b,a]);let p=o.vector([1]);for(let k=0;k<n;k++)p=o.times(p,inner);
    let outer=o.vector([1]);for(let k=0;k<n-1;k++)outer=o.times(outer,inner);outer=o.scale(outer,o.q(n));
    const d=o.derivative(p);
    for(const [mutation,right] of [['correct',d],['missing_chain_factor',outer],['inner_derivative_omitted',o.vector([n])]]) polynomialCase(`chain-${a}-${b}-${n}-${mutation}`,'derivative',{kind:'derivative',expression:`(${a}*x+${b})^${n}`,right:o.expression(right),variable:'x'},d,right,{mutationType:mutation==='correct'?null:mutation});
  }
  // Deterministic accidental agreements, caller sampling, conditioning, and
  // near-zero perturbations. Exact polynomial certificates remain the oracle.
  let trap=o.vector([1]);for(const root of [0,1,-1,2,-2])trap=o.times(trap,o.vector([-root,1]));
  for(const [name,p,options] of [['isolated-agreement',o.vector([0,-1,1]),{samples:[{x:0}]}],['sample-grid-trap',trap,{samples:[{x:0},{x:1},{x:-1},{x:2},{x:-2}]}],['off-grid-trap',trap,{}],['tiny-error',o.vector([o.q(1,1000000000000000n),1]),{}]]) polynomialCase(name,'numerical_comparison',{kind:'equivalence',left:o.expression(p),right:name==='tiny-error'?'x':'0'},p,name==='tiny-error'?o.vector([0,1]):o.vector([0]),{options,mutationType:'accidental_agreement'});
  polynomialCase('catastrophic-cancellation-correct','numerical_comparison',{kind:'equivalence',left:'(10000000000000000+x)-10000000000000000',right:'x'},o.vector([0,1]),o.vector([0,1]));
  // Domain controls and syntax variants are derived from existing reference
  // assertions, with rational witnesses for the newly restricted root domains.
  const domainSource={path:'tests/mathVerification.test.mjs',section:'original-equation solution substitution / conservative algebra evidence'};
  for(const [name,claim,assumptions,status,notes] of [
    ['known-nonzero',{kind:'equivalence',left:'x/x',right:'1'},[{variable:'x',relation:'!=',value:'0'}],'mathematically_correct','Existing nonzero-assumption regression discharges the denominator.'],
    ['positive-log',{kind:'equivalence',left:'ln(x^2)',right:'2*ln(x)'},[{variable:'x',relation:'>',value:'0'}],'mathematically_correct','Existing positive-log-assumption regression.'],
    ['positive-root-domain',{kind:'solution',left:'x^2',right:'4',value:'-2',variable:'x'},[{variable:'x',relation:'>',value:'0'}],'domain_invalid','Exact rational comparison: -2 is not > 0; pre-existing root-assumptions regression.'],
    ['near-singular-only',{kind:'equivalence',left:'1/x',right:'2/x'},[],'mathematically_incorrect','Existing singularity regression: at x=1 the exact rational values are 1 and 2.'],
  ]) put({id:name,name,origin:'existing_verifier_reference',provenance:domainSource,problem:JSON.stringify(claim),category:'domain_reasoning',claim,assumptions,options:name==='near-singular-only'?{samples:[{x:1e-15},{x:-1e-14},{x:0}]}:{},groundTruth:{status,notes,basis:'pre-existing explicit regression assertion'},supportedFalse:status!=='mathematically_correct',mutationType:status==='mathematically_correct'?null:'domain_or_singularity_control'});
  // Mathematically identical AST composition in alternative notation, certified
  // by the independent polynomial parser after its explicit TeX translation.
  for(const [i,latex] of [String.raw`\frac{2*x+2}{2}`,String.raw`\left(x+1\right)`,String.raw`\boxed{x+1}`].entries()) polynomialCase(`syntax-${i}`,'algebra',{kind:'equivalence',left:latex,right:'1+x'},o.vector([1,1]),o.parsePolynomial('1+x'),{groundTruth:{status:'mathematically_correct',basis:'existing different-syntax regression / lossless TeX grouping',notes:'Grouping/boxing does not change the pre-existing x+1 polynomial reference.'}});
  // Metamorphic mutations inherit an existing correct reference, then apply
  // a certified nonzero difference. They never ask a model to label an answer.
  for (const base of [...cases].filter(c=>c.origin==='existing_verifier_reference' && c.expectedStatus==='mathematically_correct' && ['derivative','antiderivative','numerical_comparison'].includes(c.category))) {
    for (const delta of ['1','1/1000000000000']) {
      const anti=base.claim.kind==='antiderivative';
      const claim={...base.claim,right:`(${base.claim.right})+(${delta})${anti?'*x':''}`};
      put({...base,id:`${base.id}-offset-${delta.replaceAll('/','_')}`,origin:'fixture_derived_reference_certificate',claim,problem:JSON.stringify(claim),mutationType:anti?'primitive_linear_contamination':'constant_offset',supportedFalse:true,groundTruth:{status:'mathematically_incorrect',basis:'metamorphic certificate from an existing correct reference',parentId:base.id,exactResidual:delta,notes:anti?'Adding delta*x to a correct primitive changes its derivative by the nonzero rational delta.':'Adding the nonzero rational delta changes the established correct right side by exactly delta.'},expectedAllowedStates:FALSE});
    }
  }
  // Cancellation and reciprocal mutations use cross multiplication and exact
  // rational witnesses. Their correct controls have explicit nonzero domains.
  for (const a of [1,2,5]) {
    const p=o.vector([a,1]), square=o.times(p,p), assumptions=[{variable:'x',relation:'>',value:'0'}];
    const left=`(${o.expression(square)})/(x+${a})`;
    polynomialCase(`cancel-${a}-correct`,'domain_reasoning',{kind:'equivalence',left,right:`x+${a}`},square,o.times(p,p),{assumptions});
    polynomialCase(`cancel-${a}-invalid`,'domain_reasoning',{kind:'equivalence',left,right:'x'},square,o.times(p,o.vector([0,1])),{assumptions,mutationType:'invalid_cancellation'});
    polynomialCase(`reciprocal-${a}`,'algebra',{kind:'equivalence',left:`(x+${a})/${a+1}`,right:`${a+1}/(x+${a})`},square,o.vector([(a+1)**2]),{assumptions,mutationType:'swapped_numerator_denominator'});
  }
  // Existing ln derivative assertion provides a primitive reference through
  // the definition F'=f. Rational scaling then supplies an exact defect.
  for(const k of [1,2,3]) put({id:`log-primitive-${k}`,name:`log-primitive-${k}`,origin:'fixture_derived_reference_certificate',provenance:{path:'tests/mathVerification.test.mjs',assertion:'log derivative retains positive-domain requirement'},problem:'Integrate 1/x on x>0',category:'antiderivative',claim:{kind:'antiderivative',variable:'x',integrand:'1/x',right:`${k}*ln(x)`},assumptions:[{variable:'x',relation:'>',value:'0'}],groundTruth:{status:k===1?'mathematically_correct':'mathematically_incorrect',basis:'existing ln derivative plus independent rational scale',notes:`The source establishes (ln x)'=1/x for x>0; coefficient ${k} gives residual (${k}-1)/x, nonzero at x=1 when k differs from 1.`},supportedFalse:k!==1,mutationType:k===1?null:'incorrect_logarithmic_coefficient'});
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  return cases;
}
