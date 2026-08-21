// Wires the four tabs together: create, paste, review, library.

import { parseRecipe } from './parser.js';
import { buildPaprikaFile, exportFileName } from './recipe-doc.js';
import { loadAll, save, remove, getById } from './store.js';
import { requestRecipe, getApiKey, setApiKey } from './claude.js';
import { generateDishPhoto } from './imagegen.js';

const $ = (id) => document.getElementById(id);

const els = {
  input: $('input'),
  reviewForm: $('review-form'),
  reviewEmpty: $('review-empty'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  libraryTools: $('library-tools'),
  libraryActions: $('library-actions'),
  libraryCount: $('library-count'),
  shareSelected: $('share-selected'),
  toast: $('toast'),
  help: $('help'),
  helpToggle: $('help-toggle'),
  settings: $('settings'),
  settingsToggle: $('settings-toggle'),
  apiKey: $('api-key'),
  autoPhoto: $('auto-photo'),
  keyCard: $('key-card'),
  chatLog: $('chat-log'),
  chatInput: $('chat-input'),
  composer: $('composer'),
  send: $('send'),
  chips: $('chips'),
  photoWrap: $('photo-wrap'),
  photo: $('photo'),
};

const AUTO_PHOTO_KEY = 'anylist-recipe-creator/auto-photo';

const TEXT_FIELDS = ['title', 'description', 'servings', 'prepTime', 'cookTime', 'totalTime', 'source', 'sourceUrl'];
const LIST_FIELDS = ['ingredients', 'directions', 'notes', 'nutrition'];

// The recipe currently open on the Review tab. Carries an id once saved.
let draft = null;

/* ------------------------------------------------------------------ chrome */

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function showTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    $(tab.getAttribute('aria-controls')).classList.toggle('is-active', selected);
  }
  // A hidden panel reports a scrollHeight of 0, so the textareas can only be
  // sized once the panel is actually on screen.
  if (name === 'review' && !els.reviewForm.hidden) autoGrow();
  window.scrollTo({ top: 0 });
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => showTab(tab.id.replace('tab-', '')));
}

els.helpToggle.addEventListener('click', () => {
  const open = els.help.hidden;
  els.help.hidden = !open;
  els.settings.hidden = true;
  els.helpToggle.setAttribute('aria-expanded', String(open));
  els.settingsToggle.setAttribute('aria-expanded', 'false');
});

/* ---------------------------------------------------------------- settings */

function autoPhotoEnabled() {
  try {
    return localStorage.getItem(AUTO_PHOTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

function openSettings() {
  els.apiKey.value = getApiKey();
  els.autoPhoto.checked = autoPhotoEnabled();
  els.settings.hidden = false;
  els.help.hidden = true;
  els.settingsToggle.setAttribute('aria-expanded', 'true');
  els.helpToggle.setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0 });
}

els.settingsToggle.addEventListener('click', () => {
  if (els.settings.hidden) {
    openSettings();
  } else {
    els.settings.hidden = true;
    els.settingsToggle.setAttribute('aria-expanded', 'false');
  }
});

$('open-settings').addEventListener('click', openSettings);

$('save-settings').addEventListener('click', () => {
  const key = els.apiKey.value.trim();
  if (key && !key.startsWith('sk-ant-')) {
    toast('That does not look like an Anthropic key (they start with sk-ant-).');
    return;
  }
  setApiKey(key);
  try {
    localStorage.setItem(AUTO_PHOTO_KEY, els.autoPhoto.checked ? 'on' : 'off');
  } catch {
    /* the toggle just falls back to its default */
  }
  els.settings.hidden = true;
  els.settingsToggle.setAttribute('aria-expanded', 'false');
  refreshCreateState();
  toast(key ? 'Settings saved.' : 'API key removed.');
});

/* ------------------------------------------------------------------ review */

function fillForm(recipe) {
  draft = recipe;
  for (const key of TEXT_FIELDS) $(`f-${key}`).value = recipe[key] || '';
  for (const key of LIST_FIELDS) {
    const value = recipe[key];
    $(`f-${key}`).value = Array.isArray(value) ? value.join('\n') : value || '';
  }
  $('f-categories').value = (recipe.categories || []).join(', ');
  setReviewPhoto(recipe.photoData);

  els.reviewEmpty.hidden = true;
  els.reviewForm.hidden = false;
  updateCounts();
  autoGrow();
}

function setReviewPhoto(dataUrl) {
  if (dataUrl) {
    els.photo.src = dataUrl;
    els.photoWrap.hidden = false;
  } else {
    els.photo.removeAttribute('src');
    els.photoWrap.hidden = true;
  }
  $('add-photo-row').hidden = Boolean(dataUrl);
}

function readForm() {
  const recipe = {
    id: draft?.id,
    uid: draft?.uid,
    // Not editable on the form, but they belong to the recipe being edited.
    photoData: draft?.photoData,
    imagePrompt: draft?.imagePrompt,
  };
  for (const key of TEXT_FIELDS) recipe[key] = $(`f-${key}`).value.trim();
  for (const key of LIST_FIELDS) {
    recipe[key] = $(`f-${key}`)
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  recipe.categories = $('f-categories')
    .value.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!recipe.title) recipe.title = 'Untitled Recipe';
  return recipe;
}

function updateCounts() {
  const count = (id) => $(id).value.split('\n').filter((line) => line.trim()).length;
  const ingredients = count('f-ingredients');
  const directions = count('f-directions');
  $('count-ingredients').textContent = ingredients ? `${ingredients} lines` : '';
  $('count-directions').textContent = directions ? `${directions} steps` : '';
}

// Textareas grow with their content so long ingredient lists do not sit in a
// tiny scrolling box on a phone.
function grow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 640)}px`;
}

function autoGrow() {
  for (const textarea of els.reviewForm.querySelectorAll('textarea')) grow(textarea);
}

els.reviewForm.addEventListener('input', (event) => {
  if (event.target.tagName === 'TEXTAREA') grow(event.target);
  updateCounts();
});

/* ------------------------------------------------------------------- paste */

$('parse').addEventListener('click', () => {
  const text = els.input.value;
  if (!text.trim()) {
    toast('Paste a recipe first.');
    return;
  }
  const recipe = parseRecipe(text);
  fillForm(recipe);
  showTab('review');

  if (!recipe.ingredients.length && !recipe.directions.length) {
    toast('Could not pick out the parts — edit them by hand below.');
  } else if (!recipe.ingredients.length) {
    toast('No ingredients found. Add them below.');
  } else if (!recipe.directions.length) {
    toast('No steps found. Add them below.');
  } else {
    toast(`Found ${recipe.ingredients.length} ingredients and ${recipe.directions.length} steps.`);
  }
});

$('paste-clipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      toast('The clipboard is empty.');
      return;
    }
    els.input.value = text;
    toast('Pasted. Tap Read recipe.');
  } catch {
    // Safari only allows clipboard reads from a user gesture it trusts, and
    // will refuse outright if the permission prompt is dismissed.
    toast('Safari blocked the clipboard — paste into the box instead.');
    els.input.focus();
  }
});

$('clear-input').addEventListener('click', () => {
  els.input.value = '';
  els.input.focus();
});

$('load-sample').addEventListener('click', () => {
  els.input.value = SAMPLE;
  toast('Example loaded. Tap Read recipe.');
});

/* ------------------------------------------------------------------ create */

// API-shaped history: user requests and assistant recipe JSON, oldest first.
let conversation = [];
let chatBusy = false;
// Bumped on every new generation and chat reset so a slow photo response
// can't attach itself to a newer recipe.
let generation = 0;

function refreshCreateState() {
  const hasKey = Boolean(getApiKey());
  els.keyCard.hidden = hasKey;
  els.composer.hidden = !hasKey;
  els.chips.hidden = !hasKey || !conversation.some((message) => message.role === 'assistant');
}

function addBubble(role, contentNode) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  if (typeof contentNode === 'string') {
    bubble.textContent = contentNode;
  } else {
    bubble.append(contentNode);
  }
  els.chatLog.append(bubble);
  bubble.scrollIntoView({ block: 'end' });
  return bubble;
}

function recipeCard(recipe) {
  const card = document.createElement('div');
  card.className = 'chat-card';

  const img = document.createElement('img');
  img.className = 'chat-card-photo';
  img.alt = `Photo of ${recipe.title}`;
  img.hidden = true;

  const body = document.createElement('div');
  body.className = 'chat-card-body';

  const title = document.createElement('div');
  title.className = 'chat-card-title';
  title.textContent = recipe.title;

  const meta = document.createElement('div');
  meta.className = 'chat-card-meta';
  meta.textContent = [
    recipe.servings && `Serves ${recipe.servings}`,
    recipe.prepTime && `Prep ${recipe.prepTime}`,
    recipe.cookTime && `Cook ${recipe.cookTime}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const photoNote = document.createElement('div');
  photoNote.className = 'chat-card-note';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'chat-card-open';
  open.textContent = 'Review & save';
  open.addEventListener('click', () => showTab('review'));

  body.append(title, meta, photoNote, open);
  card.append(img, body);
  return { card, img, photoNote };
}

async function attachPhoto(recipe, { img, photoNote }, { seed } = {}) {
  const token = generation;
  photoNote.textContent = 'Photographing the dish…';
  try {
    const dataUrl = await generateDishPhoto(recipe, seed === undefined ? {} : { seed });
    if (token !== generation) return; // a newer recipe took over
    recipe.photoData = dataUrl;
    if (draft === recipe) setReviewPhoto(dataUrl);
    img.src = dataUrl;
    img.hidden = false;
    photoNote.textContent = '';
  } catch (error) {
    if (token !== generation) return;
    photoNote.textContent = '';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chat-card-open';
    retry.textContent = 'Photo failed — retry';
    retry.addEventListener('click', () => {
      retry.remove();
      attachPhoto(recipe, { img, photoNote });
    });
    photoNote.append(retry);
    console.warn('Dish photo failed:', error);
  }
}

function setChatBusy(on) {
  chatBusy = on;
  els.send.disabled = on;
  els.chatInput.disabled = on;
  if (on) {
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    addBubble('assistant thinking', dots);
  } else {
    els.chatLog.querySelector('.bubble.thinking')?.remove();
  }
}

async function sendChat(text) {
  if (!text.trim() || chatBusy) return;
  addBubble('user', text.trim());
  els.chatInput.value = '';
  growComposer();
  setChatBusy(true);

  const attempt = [...conversation, { role: 'user', content: text.trim() }];
  try {
    const { recipe, assistantContent } = await requestRecipe(attempt);
    conversation = [...attempt, { role: 'assistant', content: assistantContent }];
    generation += 1;

    setChatBusy(false);
    if (recipe.reply) addBubble('assistant', recipe.reply);
    const parts = recipeCard(recipe);
    addBubble('assistant card', parts.card);

    fillForm(recipe);
    refreshCreateState();

    if (autoPhotoEnabled()) {
      attachPhoto(recipe, parts);
    }
  } catch (error) {
    setChatBusy(false);
    addBubble('assistant error', error.message);
    if (error.type === 'no-key') openSettings();
  }
}

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat(els.chatInput.value);
});

els.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChat(els.chatInput.value);
  }
});

function growComposer() {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight + 2, 160)}px`;
}
els.chatInput.addEventListener('input', growComposer);

els.chips.addEventListener('click', (event) => {
  const fill = event.target.dataset?.fill;
  if (!fill) return;
  if (fill.endsWith(' ')) {
    // An open-ended chip: let the user finish the sentence.
    els.chatInput.value = fill;
    els.chatInput.focus();
    growComposer();
  } else {
    sendChat(fill);
  }
});

$('new-chat').addEventListener('click', () => {
  conversation = [];
  generation += 1;
  els.chatLog.textContent = '';
  setChatBusy(false);
  refreshCreateState();
  els.chatInput.focus();
});

/* -------------------------------------------------------- review photo */

$('regen-photo').addEventListener('click', async () => {
  if (!draft) return;
  const recipe = draft;
  const button = $('regen-photo');
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    const dataUrl = await generateDishPhoto(
      { ...recipe, title: $('f-title').value || recipe.title },
      { seed: Math.floor(Math.random() * 100000) },
    );
    if (draft === recipe) {
      draft.photoData = dataUrl;
      setReviewPhoto(dataUrl);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'New photo';
  }
});

$('remove-photo').addEventListener('click', () => {
  if (draft) draft.photoData = undefined;
  setReviewPhoto(null);
});

$('add-photo').addEventListener('click', async () => {
  if (!draft) return;
  const recipe = draft;
  const button = $('add-photo');
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    const current = readForm();
    const dataUrl = await generateDishPhoto(current);
    if (draft === recipe) {
      draft.photoData = dataUrl;
      setReviewPhoto(dataUrl);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Generate a photo of this dish';
  }
});

/* ------------------------------------------------------------------ export */

async function exportRecipes(recipes, { share = false } = {}) {
  if (!recipes.length) {
    toast('Select at least one recipe.');
    return;
  }
  try {
    const blob = await buildPaprikaFile(recipes);
    const name = exportFileName(recipes);
    const file = new File([blob], name, { type: 'application/zip' });

    if (share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke late; iOS needs the URL alive while the download starts.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Saved ${name}. Import it at AnyList's Recipe Import page.`);
  } catch (error) {
    if (error?.name === 'AbortError') return; // the share sheet was dismissed
    toast(`Export failed: ${error.message}`);
  }
}

els.reviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const stored = save(readForm());
    draft = stored;
    renderLibrary();
    toast('Saved to your library.');
    showTab('library');
  } catch (error) {
    toast(error.message);
  }
});

$('export-current').addEventListener('click', () => exportRecipes([readForm()]));

/* ----------------------------------------------------------------- library */

function selectedIds() {
  return [...els.libraryList.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
}

function summarise(recipe) {
  const bits = [];
  if (recipe.ingredients?.length) bits.push(`${recipe.ingredients.length} ingredients`);
  if (recipe.directions?.length) bits.push(`${recipe.directions.length} steps`);
  if (recipe.servings) bits.push(`serves ${recipe.servings}`);
  return bits.join(' · ');
}

function renderLibrary() {
  const recipes = loadAll();
  els.libraryList.textContent = '';

  for (const recipe of recipes) {
    const item = document.createElement('li');
    item.className = 'recipe-item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = recipe.id;
    box.checked = true;
    box.setAttribute('aria-label', `Include ${recipe.title}`);

    const body = document.createElement('div');
    body.className = 'recipe-body';
    if (recipe.photoData) {
      const thumb = document.createElement('img');
      thumb.className = 'recipe-thumb';
      thumb.src = recipe.photoData;
      thumb.alt = '';
      body.append(thumb);
    }
    const title = document.createElement('div');
    title.className = 'recipe-title';
    title.textContent = recipe.title;
    const meta = document.createElement('div');
    meta.className = 'recipe-meta';
    meta.textContent = summarise(recipe);
    body.append(title, meta);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'recipe-edit';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      const stored = getById(recipe.id);
      if (!stored) return;
      fillForm(stored);
      showTab('review');
    });

    item.append(box, body, edit);
    els.libraryList.append(item);
  }

  const any = recipes.length > 0;
  els.libraryEmpty.hidden = any;
  els.libraryTools.hidden = !any;
  els.libraryActions.hidden = !any;
  els.libraryCount.textContent = String(recipes.length);
  els.libraryCount.dataset.zero = String(!any);
}

function setAllChecked(checked) {
  for (const box of els.libraryList.querySelectorAll('input[type="checkbox"]')) box.checked = checked;
}

$('select-all').addEventListener('click', () => setAllChecked(true));
$('select-none').addEventListener('click', () => setAllChecked(false));

$('export-selected').addEventListener('click', () => {
  const ids = new Set(selectedIds());
  exportRecipes(loadAll().filter((recipe) => ids.has(recipe.id)));
});

els.shareSelected.addEventListener('click', () => {
  const ids = new Set(selectedIds());
  exportRecipes(loadAll().filter((recipe) => ids.has(recipe.id)), { share: true });
});

$('delete-selected').addEventListener('click', () => {
  const ids = selectedIds();
  if (!ids.length) {
    toast('Select the recipes to delete.');
    return;
  }
  const label = ids.length === 1 ? 'this recipe' : `these ${ids.length} recipes`;
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  remove(ids);
  if (draft?.id && ids.includes(draft.id)) draft = { ...draft, id: undefined };
  renderLibrary();
  toast('Deleted.');
});

/* -------------------------------------------------------------------- boot */

// Only offer Share where the browser can actually put a file in the share
// sheet; on the rest, the download button is the whole story.
if (typeof navigator.canShare === 'function') {
  try {
    const probe = new File(['x'], 'probe.paprikarecipes', { type: 'application/zip' });
    els.shareSelected.hidden = !navigator.canShare({ files: [probe] });
  } catch {
    els.shareSelected.hidden = true;
  }
}

renderLibrary();
refreshCreateState();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}

const SAMPLE = `Sure! Here's a cosy weeknight dinner:

# Sheet Pan Harissa Chicken

Crispy chicken thighs and charred vegetables from a single pan.

**Prep Time:** 15 minutes
**Cook Time:** 35 minutes
**Servings:** 4
**Cuisine:** Middle Eastern

## Ingredients

### For the chicken
- 8 bone-in, skin-on chicken thighs
- 3 tbsp harissa paste
- 2 tbsp olive oil
- 1 tsp kosher salt

### For the vegetables
- 1 lb baby potatoes, halved
- 2 red onions, cut into wedges
- 1 lemon, sliced thin

## Instructions

1. Heat the oven to 425F and line a large sheet pan with parchment.
2. Toss the chicken with the harissa, olive oil and salt until evenly coated.
3. Spread the potatoes, onions and lemon on the pan, then nestle the chicken
   on top skin side up.
4. Roast for 35 minutes, until the skin is crisp and the potatoes are tender.

## Notes
- Swap the harissa for gochujang if that is what you have.
- Leftovers keep for 3 days and reheat well in a hot oven.
`;
