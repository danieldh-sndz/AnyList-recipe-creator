// Talks to the Claude API (Messages endpoint) to generate and revise recipes.
//
// This is a no-build static PWA, so the official SDK (which needs a bundler or
// a CDN import) would break the app's self-contained, offline-first design.
// The raw Messages API is called directly with fetch instead; the
// anthropic-dangerous-direct-browser-access header is what permits CORS
// requests from a browser with the user's own key.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const KEY_STORAGE = 'anylist-recipe-creator/api-key';

/* ------------------------------------------------------------ key storage */

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    if (key) {
      localStorage.setItem(KEY_STORAGE, key.trim());
    } else {
      localStorage.removeItem(KEY_STORAGE);
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- schema */

// Structured output schema: the response is guaranteed to be valid JSON in
// this shape, so no fragile text parsing is needed on the generation path.
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Name of the dish' },
    description: { type: 'string', description: 'One or two appetizing sentences about the dish' },
    servings: { type: 'string', description: 'How many the recipe serves, e.g. "4"' },
    prep_time: { type: 'string', description: 'Preparation time, e.g. "15 minutes"' },
    cook_time: { type: 'string', description: 'Cooking time, e.g. "35 minutes"' },
    total_time: { type: 'string', description: 'Total time from start to table' },
    ingredients: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One ingredient per entry with quantity and unit. A plain entry like "For the sauce" acts as a group heading.',
    },
    directions: {
      type: 'array',
      items: { type: 'string' },
      description: 'One complete step per entry, in order, without step numbers',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tips, substitutions, storage advice. Empty array if none.',
    },
    nutrition: {
      type: 'array',
      items: { type: 'string' },
      description: 'Approximate per-serving nutrition lines, e.g. "Calories: 420". Empty array if unknown.',
    },
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Course and cuisine tags, e.g. ["Dinner", "Italian"]',
    },
    image_prompt: {
      type: 'string',
      description:
        'A short photography prompt describing exactly how the finished dish looks when plated, for generating a realistic photo. Describe the food and plating only — no camera brands, no text overlays.',
    },
    reply: {
      type: 'string',
      description:
        'One or two friendly sentences to show the user about what was made or changed. No markdown.',
    },
  },
  required: [
    'title', 'description', 'servings', 'prep_time', 'cook_time', 'total_time',
    'ingredients', 'directions', 'notes', 'nutrition', 'categories', 'image_prompt', 'reply',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the recipe engine inside a small iPhone app. The user asks for a dish, or asks for changes to the recipe you already produced, and you respond with one complete recipe.

Rules:
- Always return the complete, updated recipe — never a partial diff — so the latest response always stands alone.
- When the user asks for a tweak (scaling servings, substituting an ingredient, converting units, making it vegetarian, spicier, faster, and so on), apply it to the current recipe and adjust everything affected: quantities, times, steps, servings and the description.
- When scaling, recalculate every quantity sensibly (round to practical kitchen measures) and keep cooking times realistic — doubling a roast does not double its time.
- When converting units, convert every quantity and temperature consistently.
- Write ingredient entries as "quantity unit ingredient, preparation", one per entry. Use group-heading entries like "For the sauce" only when the recipe genuinely has components.
- Keep directions clear and complete; a home cook should succeed on the first try.
- Fill in servings, prep_time, cook_time and total_time on every response.
- The image_prompt must describe the finished plated dish so a photo generator can render it realistically.`;

/* ------------------------------------------------------------- api calls */

export class ClaudeError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function friendlyError(status, body) {
  const apiMessage = body?.error?.message || '';
  if (status === 401) return 'That API key was rejected. Check it in Settings.';
  if (status === 400 && /credit|billing/i.test(apiMessage)) return 'Your Anthropic account is out of credit.';
  if (status === 429) return 'Rate limited by the API — wait a moment and try again.';
  if (status === 529) return 'The API is overloaded right now — try again shortly.';
  if (status >= 500) return 'The API had a server error — try again.';
  return apiMessage || `The API returned an error (${status}).`;
}

/**
 * Sends the conversation and returns the structured recipe.
 *
 * @param {{role: 'user'|'assistant', content: string}[]} messages
 *   Full history: user requests and prior assistant recipe JSON, oldest first.
 * @returns {Promise<{recipe: object, assistantContent: string}>}
 *   `recipe` in this app's shape; `assistantContent` is the raw JSON text to
 *   append to the history for follow-up tweaks.
 */
export async function requestRecipe(messages) {
  const key = getApiKey();
  if (!key) throw new ClaudeError('Add your Anthropic API key in Settings first.', { type: 'no-key' });

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages,
        output_config: {
          format: { type: 'json_schema', schema: RECIPE_SCHEMA },
        },
      }),
    });
  } catch {
    throw new ClaudeError('Could not reach the Claude API — check your connection.', { type: 'network' });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* handled below by status checks */
  }

  if (!response.ok) {
    throw new ClaudeError(friendlyError(response.status, body), { status: response.status, type: 'api' });
  }

  if (body?.stop_reason === 'refusal') {
    throw new ClaudeError('Claude declined that request — try rewording it.', { type: 'refusal' });
  }
  if (body?.stop_reason === 'max_tokens') {
    throw new ClaudeError('The response was cut off — try asking for a simpler recipe.', { type: 'truncated' });
  }

  const text = (body?.content || []).find((block) => block.type === 'text')?.text;
  if (!text) throw new ClaudeError('The API returned an empty response — try again.', { type: 'empty' });

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ClaudeError('The API returned something unreadable — try again.', { type: 'parse' });
  }

  return { recipe: fromApiRecipe(doc), assistantContent: text };
}

/** Maps the structured API document onto this app's recipe shape. */
function fromApiRecipe(doc) {
  const list = (value) => (Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []);
  return {
    title: String(doc.title || 'Untitled Recipe').trim(),
    description: String(doc.description || '').trim(),
    servings: String(doc.servings || '').trim(),
    prepTime: String(doc.prep_time || '').trim(),
    cookTime: String(doc.cook_time || '').trim(),
    totalTime: String(doc.total_time || '').trim(),
    ingredients: list(doc.ingredients),
    directions: list(doc.directions),
    notes: list(doc.notes),
    nutrition: list(doc.nutrition),
    categories: list(doc.categories),
    source: 'Claude',
    sourceUrl: '',
    imagePrompt: String(doc.image_prompt || '').trim(),
    reply: String(doc.reply || '').trim(),
  };
}

export { RECIPE_SCHEMA, SYSTEM_PROMPT, MODEL };
