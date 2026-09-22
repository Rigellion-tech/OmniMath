import {test, expect} from '@playwright/test';
import {graduateExpressions} from './fixtures/composer/graduateExpressions.mjs';
import {MATH_SYMBOL_REGISTRY} from '../src/lib/mathSymbolRegistry.js';

async function openComposer(page, handler) {
  const requests = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname !== '/api/explain') return route.abort();
    const body = route.request().postDataJSON();
    requests.push(body);
    if (handler) return handler(route, body);
    return route.fulfill({json: {title:'Offline mathematical solution', canonicalProblem:body.canonicalProblem,
      originalProblem:body.problem, expression:body.canonicalProblem.canonicalLatex,
      steps:[{id:'s1',label:'Inspect result',math:'x=1',summary:'Offline fixture.'}], finalAnswerLatex:'x=1'}});
  });
  await page.goto('/?mockAuth=1');
  await expect(page.getByTestId('primary-math-composer')).toHaveAttribute('data-composer-state','collapsed');
  await page.getByTestId('primary-composer-activate').click();
  await expect(page.getByTestId('primary-math-field')).toBeVisible();
  return requests;
}
const field = page => page.getByTestId('primary-math-field');
const value = page => field(page).evaluate(el=>el.getValue('latex'));
async function setValue(page, latex) {
  await field(page).evaluate((el,latex)=>{el.value=latex;el.dispatchEvent(new InputEvent('input',{bubbles:true}));},latex);
}

test('fraction is visually editable with keyboard placeholder navigation; solve and reopen preserve source', async ({page})=>{
  const requests=await openComposer(page);
  await page.getByRole('button',{name:'Insert fraction structure',exact:true}).click();
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('2');
  await expect.poll(()=>value(page)).toBe(String.raw`\frac12`);
  await expect(field(page).locator('.ML__mfrac')).toBeVisible();
  await expect(field(page)).not.toContainText(String.raw`\frac`);
  const upload=page.getByTestId('primary-image-upload-slot');
  await upload.evaluate(el=>el.dataset.preservation='same-node');
  await page.getByTestId('primary-composer-solve').click();
  await expect(page.getByTestId('primary-math-composer')).toHaveAttribute('data-composer-state','collapsed');
  expect(requests[0].canonicalProblem.canonicalLatex).toBe(String.raw`\frac12`);
  await expect(page.getByTestId('primary-composer-compact-problem').locator('.katex')).toBeVisible();
  await page.getByRole('button',{name:'Edit submitted problem'}).click();
  expect(await value(page)).toBe(requests[0].canonicalProblem.canonicalLatex);
  await expect(upload).toHaveAttribute('data-preservation','same-node');
  await page.getByTestId('primary-composer-solve').click();
  await expect.poll(()=>requests.length).toBe(2);
  expect(requests[1].canonicalProblem.hash).toBe(requests[0].canonicalProblem.hash);
});

test('common structures accept keyboard entry and matrix cells support navigation and resizing',async({page})=>{
  await openComposer(page);
  for(const id of ['power','subscript','subsup','sqrt','nthRoot','derivative','partialDerivative','definiteIntegral','indefiniteIntegral','sumStructure','productStructure','limit','cases','system']){
    await setValue(page,'');
    const entry=MATH_SYMBOL_REGISTRY.find(x=>x.id===id);
    await page.getByRole('button',{name:`Insert ${entry.name} structure`,exact:true}).click();
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('7');
    expect(await value(page),id).toContain('7');
    await page.keyboard.press('Tab');
    expect(await field(page).evaluate(el=>el.errors),id).toEqual([]);
  }
  await setValue(page,'');
  await page.getByRole('button',{name:'Insert matrix structure',exact:true}).click();
  await expect(field(page)).toBeFocused();
  for(const digit of ['1','2','3','4']){await page.keyboard.type(digit);if(digit!=='4')await page.keyboard.press('Tab');}
  expect((await value(page)).replace(/\s/g,'')).toContain(String.raw`1&2\\3&4`);
  await page.getByRole('button',{name:'Add row',exact:true}).click();
  expect((await value(page)).match(/\\\\/g).length).toBe(2);
  await page.getByRole('button',{name:'Add column',exact:true}).click();
  expect((await value(page)).match(/&/g).length).toBe(6);
});

for(const [name,latex] of graduateExpressions){
  test(`${name}: actual mathfield serialization is stable through collapse/reopen and solve`,async({page})=>{
    const requests=await openComposer(page);
    await setValue(page,latex);
    const canonical=await value(page);
    expect(canonical).not.toBe('');
    expect(await field(page).evaluate(el=>el.errors)).toEqual([]);
    await page.getByRole('button',{name:'Collapse',exact:true}).click();
    await page.getByRole('button',{name:'Edit submitted problem'}).click();
    expect(await value(page)).toBe(canonical);
    await page.getByTestId('primary-composer-solve').click();
    await expect.poll(()=>requests.length).toBe(1);
    expect(requests[0].canonicalProblem.canonicalLatex).toBe(canonical);
    expect(requests[0].problem).toBe(canonical);
    expect(JSON.stringify(requests[0])).not.toMatch(/<span|class=/);
  });
}

test('all catalog insertions parse in the real editor without unknown commands',async({page})=>{
  await openComposer(page);
  const failures=await field(page).evaluate((el,entries)=>{
    const errors=[];
    for(const item of entries){
      el.value='';el.insert(item.editorInsertion,item.insertOptions);
      if(el.errors.length||!el.value) errors.push({id:item.id,errors:el.errors,value:el.value});
    }
    return errors;
  },MATH_SYMBOL_REGISTRY);
  expect(failures).toEqual([]);
});

test('raw source is authoritative and unsupported commands are never lost on mode change or submission',async({page})=>{
  const requests=await openComposer(page);
  await setValue(page,'x+1');
  await page.getByRole('tab',{name:'Advanced LaTeX'}).click();
  const raw=page.getByTestId('primary-raw-latex');
  await expect(raw).toHaveValue('x+1');
  await raw.fill(String.raw`\specialOperator{A}_{\customIndex}`);
  await page.getByRole('tab',{name:'Visual',exact:true}).click();
  await expect(raw).toHaveValue(String.raw`\specialOperator{A}_{\customIndex}`);
  await expect(page.getByRole('alert')).toContainText('preserved');
  await page.getByTestId('primary-composer-solve').click();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0].canonicalProblem.canonicalLatex).toBe(String.raw`\specialOperator{A}_{\customIndex}`);
});

test('request failure retains editable source and retry; long expression scrolls inside workspace',async({page})=>{
  let tries=0;
  await openComposer(page,route=>route.fulfill({status:++tries===1?500:200,json:tries===1?{error:'Offline failure'}:{title:'Retry',steps:[{id:'s1',label:'Result',math:'x=1',summary:'Done'}]}}));
  await setValue(page,Array.from({length:80},(_,i)=>`x_{${i}}`).join('+'));
  const source=await value(page);
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  expect(width.scroll).toBeLessThanOrEqual(width.width);
  await page.getByTestId('primary-composer-solve').click();
  await expect(page.getByTestId('primary-composer-solve')).toBeEnabled();
  await expect(page.getByTestId('primary-math-composer')).toHaveAttribute('data-composer-state','expanded');
  expect(await value(page)).toBe(source);
  await page.getByTestId('primary-composer-solve').click();
  await expect(page.getByTestId('primary-math-composer')).toHaveAttribute('data-composer-state','collapsed');
});

test('palette categories, search, keyboard rows, recents and short desktop bounds',async({page})=>{
  await page.setViewportSize({width:1100,height:650});
  await openComposer(page);
  await page.getByRole('button',{name:'Open universal symbol browser'}).click();
  const palette=page.getByTestId('math-symbol-browser');
  const bounds=await palette.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(650);
  await palette.getByLabel('Symbol categories').getByRole('button',{name:/^greek$/i}).click();
  await palette.getByRole('textbox').fill('theta');
  await palette.getByRole('textbox').press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await value(page)).toContain('theta');
  await page.getByRole('button',{name:'Open universal symbol browser'}).click();
  await palette.getByRole('button',{name:/^recent$/i}).click();
  await expect(palette.getByRole('gridcell')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('image review stays visible and mounted when the editor collapses',async({page})=>{
  await page.setViewportSize({width:390,height:720});
  await openComposer(page);
  const data=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=700;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1000,700);ctx.fillStyle='black';ctx.font='48px serif';
    for(let i=0;i<7;i++)ctx.fillText('x + y = 12; solve the system',60,80+i*80);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({name:'offline-problem.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
  const panel=page.getByTestId('image-review-panel');
  await expect(panel).toBeVisible();
  const bounds=await panel.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(720);
  await panel.evaluate(el=>el.dataset.preservation='same-review');
  await page.getByRole('button',{name:'Collapse',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('data-preservation','same-review');
  await page.getByRole('button',{name:'Clear selected image'}).click();
  await expect(panel).toHaveCount(0);
});

test('empty structure slots cannot accidentally become solver input',async({page})=>{
  const requests=await openComposer(page);
  const selection=()=>field(page).evaluate(el=>el.selection);
  const selectedValue=()=>field(page).evaluate(el=>el.getValue(el.selection,'latex'));
  await page.getByRole('button',{name:'Insert fraction structure',exact:true}).click();
  // MathLive restores its keyboard sink asynchronously. Check actual focus
  // before typing, and verify rejection preserves the selected numerator.
  await expect(field(page)).toBeFocused();
  expect(await selectedValue()).toBe(String.raw`\placeholder{}`);
  const numeratorSelection=await selection();
  await page.getByTestId('primary-composer-solve').click();
  await expect(page.getByRole('alert')).toContainText('Fill the empty math slots');
  await expect(field(page)).toBeFocused();
  expect(requests).toHaveLength(0);
  expect(await selection()).toEqual(numeratorSelection);
  await page.keyboard.type('1');
  await expect.poll(()=>value(page)).toBe(String.raw`\frac{1}{\placeholder{}}`);
  const partialSelection=await selection();
  await page.getByTestId('primary-composer-solve').click();
  await expect(page.getByRole('alert')).toContainText('Fill the empty math slots');
  await expect(field(page)).toBeFocused();
  expect(requests).toHaveLength(0);
  expect(await selection()).toEqual(partialSelection);
  await page.keyboard.press('Tab');
  expect(await selectedValue()).toBe(String.raw`\placeholder{}`);
  await page.keyboard.type('2');
  await expect.poll(()=>value(page)).toBe(String.raw`\frac12`);
  await page.getByTestId('primary-composer-solve').click();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0].canonicalProblem.canonicalLatex).toBe(String.raw`\frac12`);
  await expect(page.getByTestId('primary-math-composer')).toHaveAttribute('data-composer-state','collapsed');
});
