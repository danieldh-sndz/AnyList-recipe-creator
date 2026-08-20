// Parses the recipe text an AI assistant produces into structured fields.
//
// Assistants are inconsistent: sometimes Markdown headings, sometimes bold
// labels, sometimes bare "Ingredients:" lines, usually wrapped in a sentence or
// two of chat. The parser handles those shapes and falls back to shape-based
// detection when a paste has no headings at all.

const SECTION_PATTERNS = [
  { key: 'ingredients', re: /^(ingredients?|what you.?ll need|shopping list)$/i },
  {
    key: 'directions',
    re: /^(directions?|instructions?|method|steps|preparation|how to make it|to make)$/i,
  },
  { key: 'notes', re: /^(notes?|tips?|tips? (and|&) (tricks|variations|notes)|chef.?s notes?|variations?|storage|make ahead|serving suggestions?)$/i },
  { key: 'nutrition', re: /^(nutrition|nutrition facts|nutritional info(rmation)?|per serving)$/i },
  { key: 'description', re: /^(description|about|summary|overview)$/i },
];

// "Prep Time: 10 minutes" and friends, however they are decorated.
const META_PATTERNS = [
  { key: 'prepTime', re: /^prep(aration)?\s*time$/i },
  { key: 'cookTime', re: /^(cook(ing)?|bake|bakinq|bake?ing)\s*time$/i },
  { key: 'totalTime', re: /^total\s*time$/i },
  { key: 'servings', re: /^(servings?|serves|yield|makes|portions?)$/i },
  { key: 'course', re: /^(course|category|meal|meal type|dish type)$/i },
  { key: 'cuisine', re: /^cuisine$/i },
  { key: 'source', re: /^(source|adapted from|recipe by|author)$/i },
  { key: 'sourceUrl', re: /^(source url|url|link)$/i },
];

const PREAMBLE_RE = /^(sure|certainly|absolutely|of course|here(?:'|’)?s|here is|here are|i(?:'|’)?d be happy|happy to|great choice|below is|this is a|enjoy|let me know|hope you|that sounds)\b/i;

const UNITS = [
  'cups?', 'c', 'tablespoons?', 'tbsps?', 'tbs', 'tb', 'teaspoons?', 'tsps?', 'ts',
  'ounces?', 'oz', 'pounds?', 'lbs?', 'grams?', 'g', 'kilograms?', 'kg',
  'milliliters?', 'ml', 'liters?', 'litres?', 'l', 'pints?', 'quarts?', 'qt', 'gallons?',
  'cloves?', 'pinch(es)?', 'dash(es)?', 'cans?', 'packages?', 'pkg', 'packets?',
  'slices?', 'sticks?', 'bunch(es)?', 'handfuls?', 'sprigs?', 'stalks?', 'heads?',
  'pieces?', 'strips?', 'fillets?', 'inch(es)?', 'large', 'medium', 'small',
];
const UNIT_RE = new RegExp(`^(?:${UNITS.join('|')})\\b`, 'i');
const FRACTIONS = '¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';
const NUMBER_WORDS = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|half|quarter)\b/i;

/** Strips Markdown decoration that would otherwise end up inside a field. */
function stripInline(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their label
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes list markers, checkboxes and "Step 3:" prefixes from a line. */
function stripMarker(line) {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*•‣◦⁃∙·–—+]\s+/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/^\s*\d{1,3}\s*[.)\]:]\s+/, '')
    .replace(/^\s*step\s*\d{1,3}\s*[:.)-]?\s*/i, '')
    .trim();
}

function hasMarker(line) {
  return (
    /^\s*[-*•‣◦⁃∙·–—+]\s+/.test(line) ||
    /^\s*\d{1,3}\s*[.)\]:]\s+/.test(line) ||
    /^\s*step\s*\d{1,3}\b/i.test(line)
  );
}

/**
 * Recognises a heading line and returns its bare text, or null.
 * Covers "## Ingredients", "**Ingredients**", "INGREDIENTS" and "Ingredients:".
 */
function headingText(rawLine) {
  const line = rawLine.trim();
  if (!line) return null;

  const md = line.match(/^#{1,6}\s+(.*)$/);
  if (md) return stripInline(md[1]).replace(/[:：]\s*$/, '').trim();

  const bold = line.match(/^\*\*(.+?)\*\*[:：]?$/);
  if (bold) return stripInline(bold[1]).replace(/[:：]\s*$/, '').trim();

  const colon = line.match(/^([A-Za-z][A-Za-z '&/-]{1,40})[:：]$/);
  if (colon) return stripInline(colon[1]).trim();

  // Bare all-caps heading such as "INGREDIENTS".
  if (/^[A-Z][A-Z '&/-]{2,40}$/.test(line)) return stripInline(line).trim();

  return null;
}

function matchSection(heading) {
  if (!heading) return null;
  const normalised = heading.replace(/[:：]\s*$/, '').trim();
  for (const { key, re } of SECTION_PATTERNS) {
    if (re.test(normalised)) return key;
  }
  return null;
}

/**
 * Pulls "Label: value" metadata out of a line.
 * Returns {key, value} or null.
 */
function matchMeta(rawLine) {
  const line = stripInline(rawLine.replace(/^#{1,6}\s+/, ''));
  const m = line.match(/^([A-Za-z][A-Za-z ]{1,24}?)\s*[:：]\s*(.+)$/);
  if (!m) return null;
  const label = m[1].trim();
  const value = m[2].trim().replace(/[.,;]$/, '');
  if (!value) return null;
  for (const { key, re } of META_PATTERNS) {
    if (re.test(label)) return { key, value };
  }
  return null;
}

/**
 * Metadata assistants often put on one line:
 * "Prep: 10 min | Cook: 20 min | Serves: 4".
 */
function matchMetaRun(rawLine) {
  const line = stripInline(rawLine.replace(/^#{1,6}\s+/, ''));
  if (!/[|•]|\s{2,}\S+\s*:/.test(line)) return null;
  const parts = line.split(/\s*[|•]\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  const found = {};
  for (const part of parts) {
    const meta = matchMeta(part);
    if (meta) found[meta.key] = meta.value;
  }
  return Object.keys(found).length ? found : null;
}

function looksLikeIngredient(line) {
  const text = stripMarker(stripInline(line));
  if (!text || text.length > 140) return false;
  if (/[.!?]\s+\S/.test(text)) return false; // reads like prose
  const first = text.replace(/^[(\[]/, '');
  if (new RegExp(`^[0-9${FRACTIONS}]`).test(first)) return true;
  if (UNIT_RE.test(first)) return true;
  if (NUMBER_WORDS.test(first) && text.split(/\s+/).length <= 8) return true;
  if (/\b(to taste|for serving|for garnish|divided|softened|melted|chopped|minced|diced|grated|thinly sliced)\b/i.test(text)) return true;
  return false;
}

/** A sub-heading inside the ingredient list, e.g. "For the sauce:". */
function isIngredientGroup(line) {
  const text = stripInline(line);
  return /^(for the\b|for\b).{0,40}[:：]?$/i.test(text) || /^.{2,40}[:：]$/.test(text);
}

function cleanBlock(lines) {
  return lines.map((line) => stripMarker(stripInline(line))).filter(Boolean);
}

/**
 * Groups direction lines into steps. When the assistant used numbering or
 * bullets, unmarked lines are treated as wrapped continuations of the step
 * above rather than as new steps.
 */
function toSteps(lines) {
  const markered = lines.some(hasMarker);
  const steps = [];
  for (const raw of lines) {
    const text = stripMarker(stripInline(raw));
    if (!text) continue;
    if (markered && !hasMarker(raw) && steps.length) {
      steps[steps.length - 1] = `${steps[steps.length - 1]} ${text}`.trim();
    } else {
      steps.push(text);
    }
  }
  return steps;
}

/**
 * Parses pasted recipe text.
 *
 * @param {string} input
 * @returns {{title:string, description:string, ingredients:string[], directions:string[],
 *   notes:string[], nutrition:string[], servings:string, prepTime:string, cookTime:string,
 *   totalTime:string, source:string, sourceUrl:string, categories:string[]}}
 */
export function parseRecipe(input) {
  const recipe = {
    title: '',
    description: '',
    ingredients: [],
    directions: [],
    notes: [],
    nutrition: [],
    servings: '',
    prepTime: '',
    cookTime: '',
    totalTime: '',
    source: '',
    sourceUrl: '',
    categories: [],
  };
  if (!input || !input.trim()) return recipe;

  const lines = String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));

  // Markdown horizontal rules are decoration, never content.
  const body = lines.filter((line) => !/^\s*([-*_]\s*){3,}$/.test(line));

  const meta = {};
  const sections = { description: [], ingredients: [], directions: [], notes: [], nutrition: [] };
  const preface = [];
  let current = null;
  let titleLine = -1;

  // An H1 marks the real start; anything before it is chat.
  const h1 = body.findIndex((line) => /^#\s+\S/.test(line));
  const start = h1 >= 0 ? h1 : 0;

  for (let i = start; i < body.length; i++) {
    const raw = body[i];
    if (!raw.trim()) {
      if (current) sections[current].push('');
      continue;
    }

    const heading = headingText(raw);
    const section = matchSection(heading);
    if (section) {
      current = section;
      continue;
    }

    const run = matchMetaRun(raw);
    if (run) {
      Object.assign(meta, run);
      continue;
    }
    const single = matchMeta(raw);
    // Inside the ingredient list "Sauce: ..." would be a group, not metadata.
    if (single && current !== 'ingredients') {
      meta[single.key] = single.value;
      continue;
    }

    if (!recipe.title) {
      // The first substantial non-chat line is the title.
      const text = stripInline(raw.replace(/^#{1,6}\s+/, ''));
      if (text && (h1 >= 0 || !PREAMBLE_RE.test(text)) && text.length <= 120) {
        recipe.title = text.replace(/[:：]\s*$/, '').trim();
        titleLine = i;
        continue;
      }
      if (text) preface.push(text);
      continue;
    }

    if (current) {
      sections[current].push(raw);
    } else if (i > titleLine) {
      // Prose between the title and the first section is the description.
      sections.description.push(raw);
    }
  }

  recipe.ingredients = cleanBlock(sections.ingredients);
  recipe.directions = toSteps(sections.directions);
  recipe.notes = cleanBlock(sections.notes);
  recipe.nutrition = cleanBlock(sections.nutrition);
  recipe.description = cleanBlock(sections.description).join(' ').trim();

  // No headings at all: split on what the lines look like.
  if (!recipe.ingredients.length && !recipe.directions.length) {
    recipe.description = '';
    const candidates = body
      .slice(titleLine + 1)
      .filter((line) => line.trim() && !matchMeta(line) && !matchMetaRun(line));
    const ingredients = [];
    const directions = [];
    let seenProse = false;
    for (const line of candidates) {
      if (!seenProse && (looksLikeIngredient(line) || (ingredients.length && isIngredientGroup(line)))) {
        ingredients.push(line);
      } else {
        seenProse = ingredients.length > 0;
        directions.push(line);
      }
    }
    recipe.ingredients = cleanBlock(ingredients);
    recipe.directions = toSteps(directions);
  }

  recipe.servings = meta.servings || '';
  recipe.prepTime = meta.prepTime || '';
  recipe.cookTime = meta.cookTime || '';
  recipe.totalTime = meta.totalTime || '';
  recipe.source = meta.source || '';
  recipe.sourceUrl = meta.sourceUrl || '';
  recipe.categories = [meta.course, meta.cuisine].filter(Boolean);

  if (!recipe.description && preface.length && !PREAMBLE_RE.test(preface[0])) {
    recipe.description = preface.join(' ');
  }
  if (!recipe.title) recipe.title = 'Untitled Recipe';

  return recipe;
}
