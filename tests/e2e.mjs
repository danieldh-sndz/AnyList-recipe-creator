// End-to-end check of the real page in a browser, at iPhone viewport size.
// Requires the app to be served locally:
//   npx http-server -p 8123 -s .
//   node tests/e2e.mjs
//
// Verifies the paste -> review -> library -> export flow and confirms the file
// the browser downloads is a valid archive.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';
const workDir = mkdtempSync(join(tmpdir(), 'recipe-e2e-'));

let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) passed++;
  else failures.push(label);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 14'], acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

// --- paste and parse ------------------------------------------------------

await page.click('#load-sample');
const pastedLength = await page.inputValue('#input').then((v) => v.length);
ok(pastedLength > 400, `example text loaded (got ${pastedLength} chars)`);

await page.click('#parse');
await page.waitForSelector('#review-form:not([hidden])');

ok(
  (await page.inputValue('#f-title')) === 'Sheet Pan Harissa Chicken',
  `title parsed (got "${await page.inputValue('#f-title')}")`,
);
ok((await page.inputValue('#f-servings')) === '4', 'servings parsed');
ok((await page.inputValue('#f-prepTime')) === '15 minutes', 'prep time parsed');

const ingredients = (await page.inputValue('#f-ingredients')).split('\n');
ok(ingredients.length === 9, `ingredient lines (got ${ingredients.length})`);
ok(ingredients[0] === 'For the chicken', `group heading kept (got "${ingredients[0]}")`);

const directions = (await page.inputValue('#f-directions')).split('\n');
ok(directions.length === 4, `step count (got ${directions.length})`);
ok(
  directions[2].includes('nestle the chicken on top skin side up'),
  'wrapped step joined into one line',
);
ok((await page.inputValue('#f-notes')).split('\n').length === 2, 'notes parsed');

// --- edit, then save ------------------------------------------------------

await page.fill('#f-title', 'Sheet Pan Harissa Chicken (edited)');
await page.click('#save-recipe');
await page.waitForSelector('#library-actions:not([hidden])');
ok((await page.textContent('#library-count')) === '1', 'library count updated');
ok(
  (await page.textContent('.recipe-title')) === 'Sheet Pan Harissa Chicken (edited)',
  'edited title stored',
);
ok(/9 ingredients/.test(await page.textContent('.recipe-meta')), 'library shows a summary');

// --- the library survives a reload ---------------------------------------

await page.reload({ waitUntil: 'networkidle' });
await page.click('#tab-library');
ok((await page.textContent('#library-count')) === '1', 'library persisted across reload');

// --- export and validate the downloaded file -----------------------------

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export-selected'),
]);

const suggested = download.suggestedFilename();
ok(suggested.endsWith('.paprikarecipes'), `download extension (got "${suggested}")`);

const downloadPath = join(workDir, 'export.paprikarecipes');
await download.saveAs(downloadPath);

try {
  const out = execFileSync('unzip', ['-t', downloadPath], { encoding: 'utf8' });
  ok(/No errors detected/.test(out), 'browser-produced archive passes unzip -t');
} catch (error) {
  ok(false, `unzip rejected the downloaded file: ${error.message}`);
}

const dest = join(workDir, 'extract');
execFileSync('unzip', ['-o', '-q', downloadPath, '-d', dest]);
const files = readdirSync(dest);
ok(files.length === 1 && files[0].endsWith('.paprikarecipe'), `entry name (got ${files})`);

const json = execFileSync('gunzip', ['-c'], {
  input: readFileSync(join(dest, files[0])),
  encoding: 'utf8',
});
const doc = JSON.parse(json);
ok(doc.name === 'Sheet Pan Harissa Chicken (edited)', `exported name (got "${doc.name}")`);
ok(doc.ingredients.split('\n').length === 9, 'exported ingredient count');
ok(doc.directions.split('\n').length === 4, 'exported step count');
ok(doc.servings === '4', 'exported servings');
ok(doc.categories.includes('Middle Eastern'), `exported categories (got ${doc.categories})`);

// --- delete ---------------------------------------------------------------

page.on('dialog', (dialog) => dialog.accept());
await page.click('#delete-selected');
await page.waitForSelector('#library-empty:not([hidden])');
ok((await page.textContent('#library-count')) === '0', 'delete clears the library');

// --- no page errors anywhere in that run ---------------------------------

ok(consoleErrors.length === 0, `no console or page errors (saw: ${consoleErrors.join(' | ')})`);

// --- the layout does not scroll sideways on a phone ----------------------

const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
ok(overflow <= 0, `no horizontal overflow (overflow was ${overflow}px)`);

await browser.close();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
