// Turns this app's recipe shape into the JSON document Paprika writes and
// AnyList reads, then packs one or more of them into a .paprikarecipes archive.

import { gzip, zipStore } from './paprika.js';

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// Paprika stores a content hash alongside each recipe. Nothing in the import
// path depends on it being cryptographic, and crypto.subtle is unavailable when
// the page is opened straight off the filesystem, so a stable non-crypto digest
// keeps the field populated everywhere.
function contentHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const digest = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return digest.repeat(4).slice(0, 64);
}

const joinLines = (value) => (Array.isArray(value) ? value.join('\n') : String(value || ''));

export function toPaprikaRecipe(recipe, now = new Date()) {
  const doc = {
    uid: recipe.uid || uuid(),
    name: (recipe.title || 'Untitled Recipe').trim(),
    directions: joinLines(recipe.directions),
    servings: String(recipe.servings || ''),
    rating: 0,
    difficulty: '',
    ingredients: joinLines(recipe.ingredients),
    notes: joinLines(recipe.notes),
    created: timestamp(now),
    image_url: null,
    on_favorites: false,
    cook_time: String(recipe.cookTime || ''),
    prep_time: String(recipe.prepTime || ''),
    source: String(recipe.source || ''),
    source_url: String(recipe.sourceUrl || ''),
    photo: null,
    photo_hash: null,
    photo_large: null,
    scale: null,
    nutritional_info: joinLines(recipe.nutrition),
    total_time: String(recipe.totalTime || ''),
    description: joinLines(recipe.description),
    categories: Array.isArray(recipe.categories) ? recipe.categories.filter(Boolean) : [],
  };
  doc.hash = contentHash(`${doc.name}${doc.ingredients}${doc.directions}`);
  return doc;
}

function safeName(name, limit) {
  const cleaned = String(name || '')
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .trim();
  return cleaned || 'Recipe';
}

// Keeps entry names unique within the archive.
function entryNames(docs) {
  const used = new Map();
  return docs.map((doc) => {
    const base = safeName(doc.name, 80);
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    return `${seen ? `${base} ${seen + 1}` : base}.paprikarecipe`;
  });
}

/**
 * Builds the finished archive: a ZIP whose entries are gzipped recipe JSON.
 *
 * @param {object[]} recipes recipes in this app's shape
 * @returns {Promise<Blob>}
 */
export async function buildPaprikaFile(recipes) {
  if (!recipes.length) throw new Error('No recipes to export.');
  const now = new Date();
  const docs = recipes.map((recipe) => toPaprikaRecipe(recipe, now));
  const names = entryNames(docs);
  const encoder = new TextEncoder();

  const entries = [];
  for (let i = 0; i < docs.length; i++) {
    // Paprika writes each recipe as a single line of JSON.
    const json = encoder.encode(JSON.stringify(docs[i]));
    entries.push({ name: names[i], data: await gzip(json) });
  }

  return new Blob([zipStore(entries, now)], { type: 'application/zip' });
}

/** Filename for the exported archive. AnyList requires the extension. */
export function exportFileName(recipes) {
  if (recipes.length === 1) {
    return `${safeName(recipes[0].title, 60)}.paprikarecipes`;
  }
  return `AnyList Recipes ${recipes.length}.paprikarecipes`;
}
