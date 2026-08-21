// End-to-end check of the Create (chat) flow with the Claude API and the
// image service mocked at the network layer, so the whole UI pipeline runs
// for real: chat -> structured recipe -> photo -> review -> export.
//
//   npx http-server -p 8123 -s .
//   node tests/e2e-create.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';
const workDir = mkdtempSync(join(tmpdir(), 'recipe-create-e2e-'));

let passed = 0;
const failures = [];
function ok(condition, label) {
  if (condition) passed++;
  else failures.push(label);
}

// A small real PNG served as the "generated" dish photo; the app decodes it
// and re-encodes to JPEG through a canvas, exercising the whole pipeline.
const TINY_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR42mN40WWFFTEMpAQApU9QQeZHOswAAAAASUVORK5CYII=',
  'base64',
);

function apiRecipe({ servings, title }) {
  return {
    title,
    description: 'A rich, gently spiced curry that comes together in one pot.',
    servings: String(servings),
    prep_time: '15 minutes',
    cook_time: '30 minutes',
    total_time: '45 minutes',
    ingredients: [
      `${servings / 2} lb chicken thighs, cubed`,
      `${servings / 4} cup coconut milk`,
      '1 onion, diced',
      '2 tbsp curry powder',
    ],
    directions: [
      'Brown the chicken in a large pot.',
      'Add the onion and curry powder and cook until fragrant.',
      'Pour in the coconut milk and simmer until the chicken is cooked through.',
    ],
    notes: ['Serve over rice.'],
    nutrition: ['Calories: 420'],
    categories: ['Dinner', 'Indian'],
    image_prompt: 'a bowl of golden chicken curry with coconut milk, garnished with cilantro',
    reply: servings === 4 ? 'Here is a cozy chicken curry for four.' : `Scaled the curry to serve ${servings}.`,
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 14'], acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const apiRequests = [];

// --- mock the Claude API ---------------------------------------------------

await page.route('https://api.anthropic.com/**', async (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') {
    await route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': '*',
      },
    });
    return;
  }

  const body = request.postDataJSON();
  apiRequests.push(body);
  const userTurns = body.messages.filter((message) => message.role === 'user').length;
  const recipe = userTurns > 1
    ? apiRecipe({ servings: 8, title: 'Cozy Chicken Curry' })
    : apiRecipe({ servings: 4, title: 'Cozy Chicken Curry' });

  await route.fulfill({
    status: 200,
    headers: { 'access-control-allow-origin': '*' },
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'msg_mock',
      type: 'message',
      model: body.model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(recipe) }],
      usage: { input_tokens: 100, output_tokens: 500 },
    }),
  });
});

// --- mock the image service -------------------------------------------------

let imageRequests = 0;
await page.route('https://image.pollinations.ai/**', async (route) => {
  imageRequests += 1;
  await route.fulfill({
    status: 200,
    headers: { 'access-control-allow-origin': '*' },
    contentType: 'image/png',
    body: TINY_IMAGE,
  });
});

// --- run the flow ------------------------------------------------------------

await page.addInitScript(() => {
  localStorage.setItem('anylist-recipe-creator/api-key', 'sk-ant-test-key');
});

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

ok(await page.isHidden('#key-card'), 'key card hidden when a key is stored');

await page.fill('#chat-input', 'A cozy chicken curry for 4');
await page.click('#send');

await page.waitForSelector('.bubble.card', { timeout: 15000 });
ok(
  (await page.textContent('.chat-card-title')) === 'Cozy Chicken Curry',
  'recipe card shows the generated title',
);
ok(
  /Serves 4/.test(await page.textContent('.chat-card-meta')),
  'card meta shows servings',
);

// The photo arrives asynchronously after the recipe.
await page.waitForSelector('.chat-card-photo:not([hidden])', { timeout: 15000 });
const cardPhotoSrc = await page.getAttribute('.chat-card-photo', 'src');
ok(cardPhotoSrc?.startsWith('data:image/'), 'card photo is an embedded data URL');
ok(imageRequests === 1, `one image request so far (got ${imageRequests})`);

// The review tab was filled in automatically, including the photo.
await page.click('#tab-review');
ok((await page.inputValue('#f-title')) === 'Cozy Chicken Curry', 'review title filled');
ok((await page.inputValue('#f-servings')) === '4', 'review servings filled');
ok((await page.inputValue('#f-prepTime')) === '15 minutes', 'review prep time filled');
ok((await page.inputValue('#f-cookTime')) === '30 minutes', 'review cook time filled');
ok(
  (await page.inputValue('#f-ingredients')).split('\n').length === 4,
  'review ingredients filled',
);
await page.waitForSelector('#photo-wrap:not([hidden])');
ok(
  (await page.getAttribute('#photo', 'src'))?.startsWith('data:image/'),
  'review photo shown',
);

// --- tweak: scaling ----------------------------------------------------------

await page.click('#tab-create');
await page.fill('#chat-input', 'Scale it to 8 servings');
await page.click('#send');
await page.waitForFunction(() => document.querySelectorAll('.bubble.card').length === 2, null, {
  timeout: 15000,
});

ok(apiRequests.length === 2, `two API calls made (got ${apiRequests.length})`);
ok(
  apiRequests[1].messages.length === 3 &&
    apiRequests[1].messages[1].role === 'assistant',
  'tweak request carries the prior recipe as history',
);
ok(apiRequests[1].output_config?.format?.type === 'json_schema', 'structured output requested');
ok(apiRequests[1].model === 'claude-opus-5', 'model is claude-opus-5');

await page.click('#tab-review');
ok((await page.inputValue('#f-servings')) === '8', 'servings updated to 8 after the tweak');

// --- save and export with the photo ------------------------------------------

await page.click('#save-recipe');
await page.waitForSelector('#library-actions:not([hidden])');
await page.waitForSelector('.recipe-thumb');
ok(true, 'library shows a photo thumbnail');

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#export-selected'),
]);
const downloadPath = join(workDir, 'export.paprikarecipes');
await download.saveAs(downloadPath);

await page.waitForSelector('#import-sheet:not([hidden])');
ok(
  (await page.getAttribute('#sheet-anylist', 'href')) === 'https://www.anylist.com/import',
  'import sheet links to the AnyList import page',
);
await page.click('#sheet-done');

execFileSync('unzip', ['-t', downloadPath]);
const dest = join(workDir, 'extract');
execFileSync('unzip', ['-o', '-q', downloadPath, '-d', dest]);
const [file] = readdirSync(dest);
const doc = JSON.parse(
  execFileSync('gunzip', ['-c'], { input: readFileSync(join(dest, file)), encoding: 'utf8' }),
);

ok(doc.name === 'Cozy Chicken Curry', `exported name (got "${doc.name}")`);
ok(doc.servings === '8', 'exported servings are the tweaked value');
ok(typeof doc.photo_data === 'string' && doc.photo_data.length > 50, 'photo embedded in the export');
const photoBytes = Buffer.from(doc.photo_data, 'base64');
ok(
  photoBytes[0] === 0xff && photoBytes[1] === 0xd8 && photoBytes[2] === 0xff,
  'exported photo decodes to JPEG bytes',
);
ok(doc.photo === `${doc.uid}.jpg`, 'photo filename matches the uid');
ok(doc.source === 'Claude', 'source records where the recipe came from');

ok(consoleErrors.length === 0, `no console or page errors (saw: ${consoleErrors.join(' | ')})`);

await browser.close();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
