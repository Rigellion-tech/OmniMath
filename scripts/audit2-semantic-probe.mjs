// Audit-only browser probe. All API traffic is intercepted; no provider calls.
import { chromium } from '@playwright/test';
import { submitCurrentComposer } from '../tests/helpers/submitCurrentComposer.mjs';
import { annotateMathExplanation } from '../server/mathAnnotator.js';

const browser = await chromium.launch({ headless: true });
const cases = process.argv.slice(2);
const fixtures = {
  scripts: [String.raw`J^2+J^*+J^{-1}+u_i'+u''+u_i^j+T_{ij}^{kl}`],
  repeated30: [Array.from({length:30}, () => 'x_i').join('+')+'=0'],
  repeated100: [Array.from({length:100}, () => 'x_i').join('+')+'=0'],
  repeated180: [Array.from({length:180}, () => 'x_i').join('+')+'=0'],
  indexed180: [Array.from({length:180}, (_,i) => `x_{${i}}`).join('+')+'=0'],
  annotated180: [Array.from({length:180}, (_,i) => `a_{${i}}`).join('+')+'=0'],
  symbols180: [Array.from({length:180}, () => 'x').join('+')+'=0'],
  superscripts100: [Array.from({length:100}, () => 'J^2').join('+')+'=0'],
  distributed: Array.from({length:20}, () => Array.from({length:9}, () => 'x_i').join('+')+'=0'),
  nested: [String.raw`\frac{a}{b+\frac{c}{d}}+\sqrt{1+\sqrt{x^2+y^2}}=\int_0^1\int_0^1f(x,y)\,dx\,dy`],
  matrix: [String.raw`\begin{pmatrix}x_i&x_i&x_i\\x_i&x_i&x_i\\x_i&x_i&x_i\end{pmatrix}`],
};
try {
  for (const name of cases.length ? cases : Object.keys(fixtures)) {
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    page.setDefaultTimeout(30000);
    console.error('audit case',name);
    const diagnostics = [];
    page.on('console', async msg => {
      if (msg.text().startsWith('[omnimath:semantic-dom-hitboxes-warning]')) {
        try { diagnostics.push(await msg.args()[1].jsonValue()); } catch { /* closed */ }
      }
    });
    await page.route('**/api/**', route => {
      const url = route.request().url();
      if (!new URL(url).pathname.startsWith('/api/')) return route.continue();
      if (url.endsWith('/api/explain')) { const solution={
        title:'Audit probe',problem:'Audit probe',expression:fixtures[name][0],
        steps:fixtures[name].map((math,i)=>({id:`audit-${i}`,label:`Audit step ${i+1}`,math,summary:'Inspect ownership.'})),
        finalAnswerLatex:'0', usage:{tier:'test',kind:'explanation',used:1,remaining:99,limit:100},
      }; return route.fulfill({json:name==='annotated180'?annotateMathExplanation(solution):solution}); }
      return route.fulfill({json:{sessions:[],history:[],title:'Probe',explanation:'Mock explanation.',usage:{remaining:99}}});
    });
    await page.goto('http://127.0.0.1:4175/?mockAuth=1', { timeout: 120000 });
    console.error('loaded',name);
    await page.getByTestId('primary-composer-activate').waitFor({timeout:60000});
    await page.evaluate(()=>{
      window.__OMNIMATH_PERF__?.reset?.();
      window.__auditLag={last:performance.now(),max:0};
      window.__auditTimer=setInterval(()=>{const now=performance.now();window.__auditLag.max=Math.max(window.__auditLag.max,now-window.__auditLag.last-16);window.__auditLag.last=now;},16);
    });
    const began=Date.now();
    await submitCurrentComposer(page,'Audit semantic ownership');
    console.error('submitted',name);
    await page.getByRole('button',{name:'Audit step 1',exact:true}).waitFor();
    const visibleMs=Date.now()-began;
    await page.waitForTimeout(12000);
    const snapshot=await page.evaluate(()=>{
      clearInterval(window.__auditTimer);
      const root=document.querySelector('.step-card [data-math-chunk-owner]');
      const katex=root?.querySelector('.katex-html');
      const owners=[...(katex?.querySelectorAll('[data-semantic-id]')||[])];
      const ids=[...new Set(owners.map(e=>e.dataset.semanticId))];
      const inspections=ids.map(id=>window.__OMNIMATH_INSPECT_SEMANTIC__?.(id)?.[0]).filter(Boolean);
      const summarize=i=>({id:i.semanticId,range:i.sourceRange,slice:i.sourceSlice,annotation:i.annotation,owners:i.owners,geometry:i.geometry});
      const first=owners.find(e=>e.textContent.trim()==='x')||owners.find(e=>e.textContent.trim()==='J')||owners[0];
      let pointer=null;
      if(first){const r=first.getBoundingClientRect();pointer={x:r.left+r.width/2,y:r.top+r.height/2};}
      const pointerInfo=pointer&&first?window.__OMNIMATH_INSPECT_SEMANTIC__?.(first.dataset.semanticId,pointer)?.[0]?.pointerSelection:null;
      return {ownerCount:owners.length,uniqueOwnerIds:ids.length,firstOwners:owners.slice(0,8).map(e=>({id:e.dataset.semanticId,text:e.textContent.slice(0,80),html:e.outerHTML.slice(0,600)})),inspections:inspections.slice(0,12).map(summarize),pointerInfo,eventLoopMax:window.__auditLag.max,perf:window.__OMNIMATH_PERF__,hoverPerf:window.__OMNIMATH_HOVER_PERF__};
    });
    const latestByChunk=new Map(diagnostics.map(d=>[d.chunkId,d]));
    const summaries=[...latestByChunk.values()].map(d=>({chunkId:d.chunkId,nodes:d.semanticNodeCount,owners:d.annotatedDomNodeCount,duplicates:d.duplicateDomMappings,rejectedCount:d.rejectedSemanticCandidates.length,rejectedUnique:new Set(d.rejectedSemanticCandidates.map(t=>t.id)).size,rejections:d.rejectedSemanticCandidates.slice(0,12),fallbacks:d.targetedFallbackMappings.slice(0,12),coverage:d.semanticNodeCoverage}));
    console.log(JSON.stringify({name,visibleMs,elapsedMs:Date.now()-began,snapshot,diagnostics:summaries}));
    await page.close();
  }
} finally {await browser.close();}
