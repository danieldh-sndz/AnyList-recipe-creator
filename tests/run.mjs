// Test suite. Run with: node tests/run.mjs
//
// The format tests deliberately shell out to the real unzip and gunzip so the
// archive is validated by tools other than the one that wrote it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRecipe } from '../js/parser.js';
import { buildPaprikaFile, exportFileName, toPaprikaRecipe } from '../js/recipe-doc.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
}

function ok(condition, label) {
  if (!condition) throw new Error(label);
}

// --------------------------------------------------------------------------
// Parser: a typical Markdown answer from an assistant
// --------------------------------------------------------------------------

const markdownRecipe = `Sure! Here's a great weeknight dinner for you:

# Creamy Tuscan Chicken

A rich one-pan dinner that comes together fast.

**Prep Time:** 10 minutes
**Cook Time:** 20 minutes
**Total Time:** 30 minutes
**Servings:** 4
**Cuisine:** Italian

## Ingredients

### For the chicken
- 4 boneless, skinless chicken breasts
- 1 tsp kosher salt
- 2 tbsp olive oil

### For the sauce
- 1 cup heavy cream
- 3 cloves garlic, minced
- ½ cup sun-dried tomatoes

## Instructions

1. Season the chicken breasts on both sides with the salt.
2. Heat the olive oil in a large skillet over medium-high heat.
   Sear the chicken for 5 minutes per side until golden.
3. Lower the heat and stir in the cream, garlic and tomatoes.

## Notes
- Leftovers keep for 3 days in the fridge.
- Swap the cream for coconut milk to make it dairy-free.
`;

await check('markdown: drops chat preamble and finds the title', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.title, 'Creamy Tuscan Chicken', 'title');
});

await check('markdown: reads the description', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.description, 'A rich one-pan dinner that comes together fast.', 'description');
});

await check('markdown: reads bold metadata', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.prepTime, '10 minutes', 'prepTime');
  eq(r.cookTime, '20 minutes', 'cookTime');
  eq(r.totalTime, '30 minutes', 'totalTime');
  eq(r.servings, '4', 'servings');
  eq(r.categories, ['Italian'], 'categories');
});

await check('markdown: keeps ingredient group headings inline', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.ingredients, [
    'For the chicken',
    '4 boneless, skinless chicken breasts',
    '1 tsp kosher salt',
    '2 tbsp olive oil',
    'For the sauce',
    '1 cup heavy cream',
    '3 cloves garlic, minced',
    '½ cup sun-dried tomatoes',
  ], 'ingredients');
});

await check('markdown: joins wrapped step text into one step', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.directions.length, 3, 'step count');
  eq(
    r.directions[1],
    'Heat the olive oil in a large skillet over medium-high heat. Sear the chicken for 5 minutes per side until golden.',
    'step 2',
  );
});

await check('markdown: collects notes', () => {
  const r = parseRecipe(markdownRecipe);
  eq(r.notes.length, 2, 'note count');
  eq(r.notes[0], 'Leftovers keep for 3 days in the fridge.', 'first note');
});

// --------------------------------------------------------------------------
// Parser: plain text with no Markdown at all
// --------------------------------------------------------------------------

const plainRecipe = `Lemon Garlic Salmon

Serves: 2
Prep time: 5 min
Cook time: 12 min

INGREDIENTS
2 salmon fillets
1 lemon, sliced
2 cloves garlic, minced
Salt and pepper to taste

INSTRUCTIONS
Preheat the oven to 400F.
Place the salmon on a lined baking sheet.
Bake for 12 minutes.
`;

await check('plain text: parses uppercase headings and bare metadata', () => {
  const r = parseRecipe(plainRecipe);
  eq(r.title, 'Lemon Garlic Salmon', 'title');
  eq(r.servings, '2', 'servings');
  eq(r.prepTime, '5 min', 'prepTime');
  eq(r.cookTime, '12 min', 'cookTime');
  eq(r.ingredients.length, 4, 'ingredient count');
  eq(r.ingredients[3], 'Salt and pepper to taste', 'last ingredient');
  eq(r.directions.length, 3, 'step count');
  eq(r.directions[0], 'Preheat the oven to 400F.', 'first step');
});

// --------------------------------------------------------------------------
// Parser: "Ingredients:" style headings, numbered steps with "Step N:"
// --------------------------------------------------------------------------

const colonRecipe = `Overnight Oats

Ingredients:
* 1/2 cup rolled oats
* 1/2 cup milk
* 1 tbsp chia seeds

Directions:
Step 1: Combine everything in a jar.
Step 2: Refrigerate overnight.
`;

await check('colon headings and Step N prefixes', () => {
  const r = parseRecipe(colonRecipe);
  eq(r.title, 'Overnight Oats', 'title');
  eq(r.ingredients, ['1/2 cup rolled oats', '1/2 cup milk', '1 tbsp chia seeds'], 'ingredients');
  eq(r.directions, ['Combine everything in a jar.', 'Refrigerate overnight.'], 'directions');
});

// --------------------------------------------------------------------------
// Parser: no headings at all, shape-based fallback
// --------------------------------------------------------------------------

const headlessRecipe = `Garlic Butter Pasta

8 oz spaghetti
4 tbsp butter
3 cloves garlic, minced
1/4 cup parsley, chopped

Boil the spaghetti in salted water until al dente.
Melt the butter in a pan and cook the garlic until fragrant.
Toss the drained pasta with the garlic butter and parsley.
`;

await check('no headings: splits ingredients from steps by shape', () => {
  const r = parseRecipe(headlessRecipe);
  eq(r.title, 'Garlic Butter Pasta', 'title');
  eq(r.ingredients.length, 4, 'ingredient count');
  ok(r.ingredients[0].startsWith('8 oz spaghetti'), 'first ingredient');
  eq(r.directions.length, 3, 'step count');
  ok(r.directions[0].startsWith('Boil the spaghetti'), 'first step');
});

// --------------------------------------------------------------------------
// Parser: single-line metadata run
// --------------------------------------------------------------------------

await check('pipe-separated metadata run', () => {
  const r = parseRecipe('# Quick Soup\n\nPrep Time: 5 min | Cook Time: 15 min | Serves: 6\n\n## Ingredients\n- 1 onion\n');
  eq(r.prepTime, '5 min', 'prepTime');
  eq(r.cookTime, '15 min', 'cookTime');
  eq(r.servings, '6', 'servings');
});

await check('empty input yields an empty recipe, not a crash', () => {
  const r = parseRecipe('');
  eq(r.title, '', 'title');
  eq(r.ingredients, [], 'ingredients');
});

await check('markdown links and inline code are unwrapped', () => {
  const r = parseRecipe('# Test\n\n## Ingredients\n- 1 cup [flour](https://example.com)\n- `2 eggs`\n');
  eq(r.ingredients, ['1 cup flour', '2 eggs'], 'ingredients');
});

// --------------------------------------------------------------------------
// Paprika document shape
// --------------------------------------------------------------------------

await check('paprika document carries the fields AnyList reads', () => {
  const doc = toPaprikaRecipe(parseRecipe(markdownRecipe));
  eq(doc.name, 'Creamy Tuscan Chicken', 'name');
  eq(doc.servings, '4', 'servings');
  eq(doc.prep_time, '10 minutes', 'prep_time');
  ok(doc.ingredients.includes('\n'), 'ingredients are newline separated');
  ok(doc.directions.includes('\n'), 'directions are newline separated');
  ok(/^[0-9a-f-]{36}$/.test(doc.uid), `uid looks like a uuid: ${doc.uid}`);
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(doc.created), `created timestamp: ${doc.created}`);
  ok(doc.hash.length === 64, 'hash is 64 hex chars');
  eq(doc.categories, ['Italian'], 'categories');
});

// --------------------------------------------------------------------------
// Archive format, validated with the real unzip and gunzip
// --------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'paprika-test-'));

async function writeArchive(recipes, fileName) {
  const blob = await buildPaprikaFile(recipes);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const path = join(workDir, fileName);
  writeFileSync(path, bytes);
  return path;
}

const recipeA = parseRecipe(markdownRecipe);
const recipeB = parseRecipe(plainRecipe);

const singlePath = await writeArchive([recipeA], 'single.paprikarecipes');
const multiPath = await writeArchive([recipeA, recipeB, { ...recipeA }], 'multi.paprikarecipes');

await check('unzip accepts the single-recipe archive', () => {
  const out = execFileSync('unzip', ['-t', singlePath], { encoding: 'utf8' });
  ok(/No errors detected/.test(out), `unzip -t said:\n${out}`);
});

await check('unzip accepts the multi-recipe archive', () => {
  const out = execFileSync('unzip', ['-t', multiPath], { encoding: 'utf8' });
  ok(/No errors detected/.test(out), `unzip -t said:\n${out}`);
  const listing = execFileSync('zipinfo', ['-1', multiPath], { encoding: 'utf8' }).trim().split('\n');
  eq(listing.length, 3, 'entry count');
  ok(listing.every((n) => n.endsWith('.paprikarecipe')), `entry names: ${listing}`);
  eq(new Set(listing).size, 3, 'entry names are unique');
});

await check('each entry gunzips to the recipe JSON', () => {
  const dest = join(workDir, 'extracted');
  execFileSync('unzip', ['-o', '-q', multiPath, '-d', dest]);
  const files = readdirSync(dest);
  eq(files.length, 3, 'extracted file count');

  const names = [];
  for (const file of files) {
    const path = join(dest, file);
    // gunzip refuses a name without .gz, so decompress through stdin.
    const json = execFileSync('gunzip', ['-c'], { input: readFileSync(path), encoding: 'utf8' });
    ok(!json.includes('\n'), `${file} is a single JSON line`);
    const doc = JSON.parse(json);
    ok(typeof doc.name === 'string' && doc.name.length > 0, `${file} has a name`);
    ok(typeof doc.ingredients === 'string', `${file} ingredients is a string`);
    ok(typeof doc.directions === 'string', `${file} directions is a string`);
    ok(Array.isArray(doc.categories), `${file} categories is an array`);
    names.push(doc.name);
  }
  ok(names.includes('Creamy Tuscan Chicken'), `names: ${names}`);
  ok(names.includes('Lemon Garlic Salmon'), `names: ${names}`);
});

await check('round trip preserves ingredient and step text exactly', () => {
  const dest = join(workDir, 'single-extract');
  execFileSync('unzip', ['-o', '-q', singlePath, '-d', dest]);
  const [file] = readdirSync(dest);
  const json = execFileSync('gunzip', ['-c'], { input: readFileSync(join(dest, file)), encoding: 'utf8' });
  const doc = JSON.parse(json);
  eq(doc.ingredients.split('\n'), recipeA.ingredients, 'ingredients round trip');
  eq(doc.directions.split('\n'), recipeA.directions, 'directions round trip');
  eq(doc.notes.split('\n'), recipeA.notes, 'notes round trip');
});

await check('unicode in titles and ingredients survives the round trip', () => {
  const unicode = parseRecipe('# Crème Brûlée à la Vanille\n\n## Ingredients\n- ½ cup sucre\n- 1 gousse de vanille\n\n## Instructions\n1. Mélanger.\n');
  return writeArchive([unicode], 'unicode.paprikarecipes').then((path) => {
    execFileSync('unzip', ['-t', path]);
    const dest = join(workDir, 'unicode-extract');
    execFileSync('unzip', ['-o', '-q', path, '-d', dest]);
    const [file] = readdirSync(dest);
    const doc = JSON.parse(
      execFileSync('gunzip', ['-c'], { input: readFileSync(join(dest, file)), encoding: 'utf8' }),
    );
    eq(doc.name, 'Crème Brûlée à la Vanille', 'unicode title');
    ok(doc.ingredients.includes('½ cup sucre'), 'unicode ingredient');
  });
});

// The fallback matters: it is the path taken on Safari builds without
// CompressionStream, so it has to produce equally valid gzip.
await check('the no-CompressionStream fallback still writes valid gzip', async () => {
  const saved = globalThis.CompressionStream;
  delete globalThis.CompressionStream;
  try {
    const fresh = await import('../js/recipe-doc.js?fallback=1');
    const blob = await fresh.buildPaprikaFile([recipeA]);
    const path = join(workDir, 'fallback.paprikarecipes');
    writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
    execFileSync('unzip', ['-t', path]);
    const dest = join(workDir, 'fallback-extract');
    execFileSync('unzip', ['-o', '-q', path, '-d', dest]);
    const [file] = readdirSync(dest);
    const doc = JSON.parse(
      execFileSync('gunzip', ['-c'], { input: readFileSync(join(dest, file)), encoding: 'utf8' }),
    );
    eq(doc.name, 'Creamy Tuscan Chicken', 'fallback recipe name');
  } finally {
    globalThis.CompressionStream = saved;
  }
});

await check('export file names use the required extension', () => {
  eq(exportFileName([{ title: 'Creamy Tuscan Chicken' }]), 'Creamy Tuscan Chicken.paprikarecipes', 'single');
  eq(exportFileName([{ title: 'A' }, { title: 'B' }]), 'AnyList Recipes 2.paprikarecipes', 'multiple');
  eq(exportFileName([{ title: 'Soup/Stew: 100% "Best"' }]), 'Soup Stew 100% Best.paprikarecipes', 'sanitised');
});

rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);
process.exit(failures.length ? 1 : 0);
