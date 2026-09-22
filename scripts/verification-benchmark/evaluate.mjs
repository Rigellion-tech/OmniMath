import fs from 'node:fs';
import { verifyMathClaim, VERIFICATION_VERSION } from '../../server/verification/mathVerifier.js';
import { verifySolution } from '../../server/verification/solutionVerifier.js';
import { CATEGORIES, buildCorpus } from './corpus.mjs';
export const STATES=['verified','numerically_supported','inconclusive','contradicted'];
const count=(rows,f)=>rows.filter(f).length;
const correct=r=>r.expectedStatus==='mathematically_correct';
const falseClaim=r=>['mathematically_incorrect','domain_invalid'].includes(r.expectedStatus);
// Keep denominators and unknown truth explicit; undefined precision is null,
// never a misleading 100%. These are finite corpus statistics, not estimates
// from independent production samples.
export function metrics(rows) {
  const counts=Object.fromEntries(STATES.map(s=>[s,count(rows,r=>r.evidence.state===s)]));
  const ratio=(n,d)=>({numerator:n,denominator:d,value:d?n/d:null});
  return {total:rows.length,...counts,
    contradictionPrecision:ratio(count(rows,r=>r.evidence.state==='contradicted'&&falseClaim(r)),counts.contradicted),
    contradictionRecall:ratio(count(rows,r=>r.supportedFalse&&falseClaim(r)&&r.evidence.state==='contradicted'),count(rows,r=>r.supportedFalse&&falseClaim(r))),
    falseContradictionRate:ratio(count(rows,r=>correct(r)&&r.evidence.state==='contradicted'),count(rows,correct)),
    verifiedPrecision:ratio(count(rows,r=>correct(r)&&r.evidence.state==='verified'),counts.verified),
    numericalSupportPrecision:ratio(count(rows,r=>correct(r)&&r.evidence.state==='numerically_supported'),counts.numerically_supported),
    inconclusiveRate:ratio(counts.inconclusive,rows.length),
    unknownTruth:count(rows,r=>r.expectedStatus==='unsupported_ambiguous')};
}
export function auditExtraction(fixtures=JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/verification/solution-fields.json',import.meta.url),'utf8'))) {
  const rows=fixtures.map(f=>{
    const report=verifySolution(f.candidate,{problem:f.problem,inputSource:f.origin==='stored_provider_diagnostic'?'stored_reviewed_input':'fixture_input'});
    // Interpretation into a check is distinct from successful parsing. A free
    // equation deliberately suppressed as a possible constraint is not a claim.
    const checks=report.checks.filter(c=>c.id!=='coverage-limit');
    const recognized=checks.filter(c=>!['claim_interpretation','claim_parsing'].includes(c.method));
    const availableFields=(f.candidate.steps||[]).flatMap((s,i)=>['latex','math','equationLatex'].filter(k=>typeof s[k]==='string'&&s[k].trim()).map(k=>`steps[${i}].${k}`));
    for(const k of ['finalAnswerLatex','finalAnswer'])if(typeof f.candidate[k]==='string'&&f.candidate[k].trim())availableFields.push(k);
    const nonempty=checks.filter(c=>c.expression?.trim());
    const examinedPaths=new Set(nonempty.map(c=>c.fieldPath));
    return {id:f.id,origin:f.origin,provenance:f.provenance,inputAvailable:Boolean(f.problem),candidateFields:availableFields.length,examinedFields:nonempty.length,recognized:recognized.length,skipped:availableFields.length-recognized.length,counts:Object.fromEntries(STATES.map(s=>[s,nonempty.filter(c=>c.state===s).length])),unexaminedFields:availableFields.filter(p=>!examinedPaths.has(p)),finalRecognized:recognized.some(c=>c.final),checks:nonempty.map(({fieldPath,expression,kind,state,method,reason,linkedInput})=>({fieldPath,expression,kind,state,method,reason,linkedInput}))};
  });
  const summarize=items=>({candidates:items.length,candidateFields:items.reduce((n,r)=>n+r.candidateFields,0),examinedFields:items.reduce((n,r)=>n+r.examinedFields,0),recognized:items.reduce((n,r)=>n+r.recognized,0),skipped:items.reduce((n,r)=>n+r.skipped,0),finalsRecognized:items.filter(r=>r.finalRecognized).length,missingInputs:items.filter(r=>!r.inputAvailable).length,...Object.fromEntries(STATES.map(s=>[s,items.reduce((n,r)=>n+r.counts[s],0)]))});
  return {summary:summarize(rows),byOrigin:Object.fromEntries([...new Set(rows.map(r=>r.origin))].map(origin=>[origin,summarize(rows.filter(r=>r.origin===origin))])),rows};
}
export function runBenchmark(corpus=buildCorpus()) {
  const rows=corpus.map(c=>({...c,evidence:verifyMathClaim(c.claim,{...c.options,assumptions:c.assumptions})}));
  const group=key=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].sort().map(k=>[k,metrics(rows.filter(r=>r[key]===k))]));
  const failures=rows.filter(r=>!r.expectedAllowedStates.includes(r.evidence.state));
  return {schemaVersion:1,verifierVersion:VERIFICATION_VERSION,overall:metrics(rows),byCategory:Object.fromEntries(CATEGORIES.map(c=>[c,metrics(rows.filter(r=>r.category===c))])),byMethod:Object.fromEntries([...new Set(rows.map(r=>r.evidence.method))].sort().map(m=>[m,metrics(rows.filter(r=>r.evidence.method===m))])),byOrigin:group('origin'),byGroundTruth:group('expectedStatus'),failures:failures.map(r=>({id:r.id,status:r.expectedStatus,state:r.evidence.state,reason:r.evidence.reason})),falseContradictions:rows.filter(r=>correct(r)&&r.evidence.state==='contradicted').map(r=>r.id),falseVerified:rows.filter(r=>falseClaim(r)&&r.evidence.state==='verified').map(r=>r.id),extraction:auditExtraction(),rows};
}
