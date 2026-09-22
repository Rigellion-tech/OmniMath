// Offline, static extraction only. Never imports test modules or executes fixture code.
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
const out = new URL('../../tests/fixtures/verification/', import.meta.url);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
let checker;
function literal(n, depth=0) {
  if (!n || depth>30) return undefined;
  if (ts.isIdentifier(n)) {
    const declaration=checker?.getSymbolAtLocation(n)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) ? literal(declaration.initializer,depth+1) : undefined;
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === 'String.raw' && ts.isNoSubstitutionTemplateLiteral(n.template)) return n.template.rawText;
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(e=>literal(e,depth+1));
  if (ts.isObjectLiteralExpression(n)) return Object.fromEntries(n.properties.filter(ts.isPropertyAssignment).map(p => [p.name.text, literal(p.initializer,depth+1)]));
  return undefined;
}
const references = []; const solutions = [];
const paths = ['tests/mathVerification.test.mjs','tests/fastSolvePipeline.test.mjs','tests/stokesRegression.test.mjs','tests/solveCandidateLifecycle.test.mjs','tests/semanticCoverageAudit.test.mjs','tests/semanticMathRenderer.test.mjs','tests/ocrExtractionValidation.test.mjs'];
const program=ts.createProgram(paths,{allowJs:true,noResolve:true});
checker=program.getTypeChecker();
for (const path of paths) {
  const source = fs.readFileSync(path,'utf8');
  const file = program.getSourceFile(path);
  function walk(n) {
    const provenance = { path, line: file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1, sha256: hash(source) };
    if (path.endsWith('mathVerification.test.mjs') && ts.isForOfStatement(n) && ts.isArrayLiteralExpression(n.expression)) {
      const columns = n.initializer.declarations[0].name.elements.map(e => e.name.text);
      for (const row of literal(n.expression)) if (Array.isArray(row)) references.push({ ...provenance, ...Object.fromEntries(columns.map((k,i) => [k,row[i]])) });
    }
    if (ts.isObjectLiteralExpression(n)) {
      const value = literal(n);
      if (Array.isArray(value.steps) && (typeof value.finalAnswerLatex === 'string' || typeof value.finalAnswer === 'string')) {
        const candidate = { steps: value.steps.map(s => Object.fromEntries(Object.entries(s || {}).filter(([k,v]) => ['id','latex','math','equationLatex'].includes(k) && typeof v === 'string'))), ...Object.fromEntries(['finalAnswerLatex','finalAnswer'].filter(k => typeof value[k] === 'string').map(k => [k,value[k]])) };
        let problem=value.problemLatex || value.expression || '';
        for(let parent=n.parent;!problem && parent;parent=parent.parent) {
          if(ts.isCallExpression(parent)) for(const arg of parent.arguments) {
            const context=ts.isObjectLiteralExpression(arg)?literal(arg):null;
            if(typeof context?.problem==='string') problem=context.problem;
          }
        }
        const unresolvedSteps=value.steps.filter(s=>!s || !['latex','math','equationLatex'].some(k=>typeof s[k]==='string')).length;
        solutions.push({ id: `${path}:${provenance.line}`, provenance, origin: 'existing_integration_fixture', problem, unresolvedSteps, candidate });
      }
    }
    ts.forEachChild(n,walk);
  }
  walk(file);
}
for (const name of fs.readdirSync('logs/failed-solves').filter(n => n.endsWith('.json')).sort()) {
  const path = `logs/failed-solves/${name}`; const text = fs.readFileSync(path,'utf8'); const d=JSON.parse(text);
  const stage = ['sanitizedNormalizedSolutionJson','schemaSanitizedJson','parsedJsonBeforeSchemaNormalization'].find(k => d.modelResult[k] && typeof d.modelResult[k] === 'object');
  const s=d.modelResult[stage]; const i=d.input;
  solutions.push({id:name, origin:'stored_provider_diagnostic', provenance:{path,sha256:hash(text),stage}, problem:i.canonicalMathInput || i.canonicalLatex || i.canonicalProblem?.canonicalLatex || i.canonicalNormalizedSolverInput || '', candidate:{steps:(s.steps || []).map(step => Object.fromEntries(Object.entries(step).filter(([k,v]) => ['id','latex','math','equationLatex'].includes(k) && typeof v === 'string'))), finalAnswerLatex:s.finalAnswerLatex || s.finalAnswer || ''}});
}
const replayPath='tests/fixtures/validation/live-symbol-provenance-replay.json'; const replay=JSON.parse(fs.readFileSync(replayPath,'utf8'));
for (const [i,s] of replay.candidates.entries()) solutions.push({id:`live-replay-${i}`,origin:'reconstructed_live_excerpt',provenance:{path:replayPath},problem:replay.problem.latex,candidate:{steps:s.steps.map(({id,math,latex})=>({id,...(math?{math}:{}),...(latex?{latex}:{})})),finalAnswerLatex:s.finalAnswerLatex}});
const p='tests/fixtures/orchestration/terra-differential-quality-repair.json'; const d=JSON.parse(fs.readFileSync(p,'utf8'));
for (const k of ['initialSolve','repairTriggerSolve']) solutions.push({id:k,origin:k==='initialSolve'?'reconstructed_live_excerpt':'existing_synthetic_control',provenance:{path:p},problem:d.problem.latex,candidate:{steps:d[k].steps.map(({id,latex})=>({id,latex})),finalAnswerLatex:d[k].finalAnswerLatex}});
fs.writeFileSync(new URL('reference-claims.json',out),JSON.stringify(references,null,2)+'\n');
fs.writeFileSync(new URL('solution-fields.json',out),JSON.stringify(solutions,null,2)+'\n');
console.log(JSON.stringify({referenceClaims:references.length,solutionCandidates:solutions.length,origins:solutions.reduce((a,s)=>(a[s.origin]=(a[s.origin]||0)+1,a),{})}));
