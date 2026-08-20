# Recipe to AnyList

A small web app for your iPhone. Paste the recipe an AI assistant wrote, check the
fields, and get a file that AnyList imports directly — no retyping.

Everything runs in the browser on your phone. No account, no server, and no recipe
text ever leaves the device.

## Why a file instead of a direct import

AnyList imports recipes from web pages that publish schema.org markup, which a
block of chat text does not have. What AnyList *also* accepts is the Paprika
recipe format, so that is what this app writes: a `.paprikarecipes` file you hand
to AnyList's Recipe Import page.

A `.paprikarecipes` file is a ZIP archive whose entries are gzip-compressed JSON
recipe documents. The app builds both the gzip and the ZIP itself, in JavaScript,
with no dependencies.

## Setting it up on your iPhone

1. Publish the app. The included GitHub Actions workflow deploys it to GitHub
   Pages — in the repository, open **Settings → Pages** and set **Source** to
   **GitHub Actions**. The next push to `main` publishes it.
2. Open the published URL in Safari on your iPhone.
3. Tap the Share button, then **Add to Home Screen**. It now opens full screen
   like an app and works with no connection.

To try it without publishing anything, run it locally:

```sh
npx http-server -p 8123 -s .
# then open http://localhost:8123
```

## Using it

1. **Paste** — paste the recipe text and tap **Read recipe**. Markdown headings,
   bold labels, bullets, numbered steps and plain text all work.
2. **Review** — the app fills in title, description, servings, times, ingredients,
   steps and notes. Fix anything it got wrong; the fields are all editable.
   Ingredients and steps are one per line.
3. **Library** — tap **Save to library** to keep the recipe on the device, so you
   can collect several and export them in one file. Tap **Export selected** to
   save the `.paprikarecipes` file to Files.

Then import it into AnyList:

1. Open AnyList's **Recipe Import** page in Safari and sign in. The steps are on
   [AnyList's help page](https://help.anylist.com/articles/paprika-import/).
2. Choose the file you saved and tap **Import Recipes**.

The recipes land in your AnyList account and sync to every device on it.

## What the parser handles

| Input shape | Example |
| --- | --- |
| Chat preamble | `Sure! Here's a recipe…` is dropped when a title heading follows |
| Markdown headings | `# Title`, `## Ingredients`, `## Instructions` |
| Bold labels | `**Prep Time:** 10 minutes` |
| Plain labels | `Serves: 4`, `Cook time: 20 min` |
| One-line metadata | `Prep: 5 min \| Cook: 15 min \| Serves: 6` |
| Uppercase headings | `INGREDIENTS`, `INSTRUCTIONS` |
| Colon headings | `Ingredients:`, `Directions:` |
| Ingredient groups | `### For the sauce` is kept as a heading line |
| Step prefixes | `1.`, `1)`, `Step 1:`, `-`, `*`, `•` |
| Wrapped steps | An unmarked line continues the numbered step above it |
| No headings at all | Ingredients and steps are separated by how the lines look |

Anything it misreads is editable on the Review tab before you export.

## Project layout

```
index.html            markup for the three tabs
styles.css            iPhone-first styling, light and dark
js/app.js             UI wiring
js/parser.js          pasted text -> structured recipe
js/paprika.js         CRC32, gzip and ZIP writing
js/recipe-doc.js      recipe -> Paprika JSON -> .paprikarecipes archive
js/store.js           the on-device recipe library
sw.js                 offline cache for the app shell
tools/make-icons.py   regenerates the app icons
tests/run.mjs         parser and file-format tests
tests/e2e.mjs         browser test of the whole flow
```

## Tests

The format tests shell out to the real `unzip` and `gunzip`, so the archive is
validated by tools other than the one that wrote it.

```sh
npm test                                  # parser + file format

npx http-server -p 8123 -s . &            # browser flow, needs Playwright
node tests/e2e.mjs
```

`tests/e2e.mjs` drives the real page at iPhone viewport size: it pastes a recipe,
checks what the parser produced, saves it, reloads to confirm the library
persisted, exports, and then validates the downloaded file with `unzip` and
`gunzip`.

## Notes

- Saved recipes live in the browser's local storage for this site. Clearing
  Safari's website data clears the library, so export anything you want to keep.
- The gzip step uses `CompressionStream` where it exists and falls back to a
  built-in writer on older Safari versions. Both paths are covered by tests.
