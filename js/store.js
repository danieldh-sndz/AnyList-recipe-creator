// Saved recipes live in localStorage so the library survives a reload and the
// app keeps working with no network. Nothing leaves the device.

const KEY = 'anylist-recipe-creator/v1';

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt entry should not brick the app.
    return [];
  }
}

function persist(recipes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recipes));
    return true;
  } catch {
    return false;
  }
}

/** Inserts a new recipe or updates an existing one, newest first. */
export function save(recipe) {
  const recipes = loadAll();
  const stored = { ...recipe, id: recipe.id || newId(), savedAt: Date.now() };
  const index = recipes.findIndex((item) => item.id === stored.id);
  if (index >= 0) {
    recipes[index] = stored;
  } else {
    recipes.unshift(stored);
  }
  if (!persist(recipes)) throw new Error('Could not save — this device is out of storage.');
  return stored;
}

export function remove(ids) {
  const drop = new Set(ids);
  const recipes = loadAll().filter((recipe) => !drop.has(recipe.id));
  persist(recipes);
  return recipes;
}

export function getById(id) {
  return loadAll().find((recipe) => recipe.id === id) || null;
}
