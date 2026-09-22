import { test, expect } from '@playwright/test';
import katex from 'katex';
import { variationalFunctionalLatex, fractionCases } from './fixtures/composer/variationalFunctional.mjs';

const field = page => page.getByTestId('primary-math-field');
const value = page => field(page).evaluate(element => element.getValue('latex'));

async function openComposer(page) {
  const requests = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname !== '/api/explain') return route.abort();
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: { title: 'Offline solution', originalProblem: body.problem,
      steps: [{ id: 's1', label: 'Result', math: 'x=1', summary: 'Offline fixture.' }], finalAnswerLatex: 'x=1' } });
  });
  await page.goto('/?mockAuth=1');
  await page.getByTestId('primary-composer-activate').click();
  await expect(field(page)).toBeVisible();
  return requests;
}

async function pasteFormats(page, formats) {
  await field(page).evaluate((element, data) => {
    const clipboardData = new DataTransfer();
    for (const [type, content] of Object.entries(data)) clipboardData.setData(type, content);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, composed: true, cancelable: true, clipboardData }));
  }, formats);
}

function rendered(latex) {
  return katex.renderToString(latex, { output: 'htmlAndMathml', throwOnError: true, strict: 'ignore' });
}

test('formatted KaTeX paste preserves all four fraction coefficients and the exact canonical request', async ({ page }) => {
  const requests = await openComposer(page);
  await pasteFormats(page, { 'text/html': rendered(variationalFunctionalLatex), 'text/plain': 'J[u]=21+4α+2β-pλ' });
  const canonical = await value(page);
  expect(canonical).toBe(variationalFunctionalLatex);
  for (const { numerator, denominator } of fractionCases.slice(0, 4)) {
    const expected = String.raw`\frac{${numerator}}{${denominator}}`;
    expect(canonical, `${numerator} over ${denominator}`).toContain(expected);
  }
  expect(canonical).toContain(String.raw`\int_\Omega`);
  expect(canonical).toContain(String.raw`\text{ where }`);
  expect(canonical).toContain(String.raw`\alpha>0,\beta>0,\lambda>0,2<p<6`);
  expect(canonical).not.toContain('21+4α+2β-pλ');
  await page.getByTestId('primary-composer-solve').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].canonicalProblem.canonicalLatex).toBe(canonical);
  expect(requests[0].problem).toBe(canonical);
});

test('formatted adjacent math, nested groups, powers and subscripts stay structured; unsupported math is rejected', async ({ page }) => {
  await openComposer(page);
  const first = rendered(String.raw`\alpha`);
  const second = rendered(String.raw`b_{i}^{2}+\int_0^1\frac{1+\frac{x}{2}}{(a+b)^2}\,dx+\frac{a+b}{c+d}x_i^2`);
  await pasteFormats(page, { 'text/html': `<p>${first}${second}</p>`, 'text/plain': 'αbi2+...' });
  const canonical = await value(page);
  expect(canonical).toContain(String.raw`\alpha`);
  expect(canonical).toContain(String.raw`b_{i}^{2}`);
  expect(canonical).toContain(String.raw`\frac{1+\frac{x}{2}}{(a+b)^2}`);
  expect(canonical).toContain(String.raw`\int_0^1`);
  expect(canonical).toContain(String.raw`\frac{a+b}{c+d}x_i^2`);
  expect(canonical).not.toContain(String.raw`\alphab`);
  await pasteFormats(page, { 'text/html': '<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>', 'text/plain': '21' });
  expect(await value(page)).toBe(canonical);
  await expect(page.getByRole('alert')).toContainText('no editable LaTeX source');
});

test('MathML semantic source wins over unannotated HTML, mixed prose remains text, and paste supports native undo', async ({ page }) => {
  await openComposer(page);
  await pasteFormats(page, {
    'text/html': '<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>',
    'application/mathml+xml': '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mfrac><mn>1</mn><mn>2</mn></mfrac><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math>',
    'text/plain': '21',
  });
  expect(await value(page)).toContain(String.raw`\frac{1}{2}`);
  await field(page).evaluate(element => { element.value = ''; element.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await pasteFormats(page, { 'text/html': `where ${rendered(String.raw`\alpha>0`)} and ${rendered(String.raw`\beta>0`)}`,
    'text/plain': 'where α>0 and β>0' });
  const mixed = await value(page);
  expect(mixed).toContain(String.raw`\text{where}`);
  expect(mixed).toContain(String.raw`\alpha>0`);
  expect(mixed).toContain(String.raw`\text{and}`);
  expect(mixed).toContain(String.raw`\beta>0`);
  await field(page).focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => value(page)).toBe('');
  await page.keyboard.press('Control+y');
  await expect.poll(() => value(page)).toBe(mixed);
});

test('spacebar creates math spacing, text mode keeps prose spaces, and plain clipboard paste remains native', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openComposer(page);
  await field(page).focus();
  await page.keyboard.type('x y');
  await expect.poll(() => value(page)).toContain(String.raw`x\,y`);
  await field(page).evaluate(element => { element.value = ''; element.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await field(page).focus();
  await page.keyboard.type('dx, where α > 0');
  await expect.poll(() => value(page)).toContain(String.raw`,\,where\,`);
  await page.getByRole('button', { name: 'Text mode' }).click();
  await page.keyboard.type(' where alpha > 0');
  await expect.poll(() => value(page)).toContain(String.raw`\text{ where alpha > 0}`);
  await page.getByRole('button', { name: 'Math mode' }).click();
  await page.evaluate(() => navigator.clipboard.writeText('z+1'));
  await page.keyboard.press('Control+v');
  await expect.poll(() => value(page)).toContain('z+1');
});

test('native browser rich clipboard paste prefers KaTeX semantic source over flattened visual text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const requests = await openComposer(page);
  const html = rendered(String.raw`\frac{\alpha}{4}`);
  const flattened = await page.evaluate(markup => {
    const template = document.createElement('template');
    template.innerHTML = markup;
    return template.content.querySelector('.katex-html').textContent;
  }, html);
  expect(flattened).toContain('4α');
  await page.evaluate(async ({ markup, plain }) => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([markup], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    })]);
  }, { markup: html, plain: flattened });
  await field(page).focus();
  await page.keyboard.press('Control+v');
  await expect.poll(() => value(page)).toBe(String.raw`\frac{\alpha}{4}`);
  await page.getByTestId('primary-composer-solve').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].canonicalProblem.canonicalLatex).toBe(String.raw`\frac{\alpha}{4}`);
});
