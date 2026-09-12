const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const path = require('node:path');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The real shipped prompt files, copied into the temp static directory.
 *
 * Seeding stand-ins would test the categoriser against a list this file wrote,
 * which is exactly the list that cannot go stale. Copying the shipped ones
 * means a seventh feature added without a category fails here.
 */
function withShippedPrompts(staticDir) {
  const source = path.join(__dirname, '..', 'static', 'prompts');
  const target = path.join(staticDir, 'prompts');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    if (file.endsWith('.json')) fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

/**
 * Sorting the prompts into Building and Extracting.
 *
 * The line is what a prompt PRODUCES, not what it reads: an extracting prompt
 * turns source material into structured data, a building prompt turns that data
 * into what the user receives. Both read and both write, so any other line
 * would be arbitrary - which is why the split is pinned here rather than left
 * to whoever adds the next feature.
 */

test('every shipped feature is filed under one of the two categories', async () => {
  const { staticDir } = useTempStorage('prompt-categories-cover');
  withShippedPrompts(staticDir);
  const { listPrompts } = loadFresh('../dist/services/promptService');

  const prompts = await listPrompts();
  const byFeature = new Map(prompts.filter((p) => p.featureKey).map((p) => [p.featureKey, p]));

  assert.equal(byFeature.get('analyze-job-description').category, 'extracting');
  assert.equal(byFeature.get('extract-profile-from-resume').category, 'extracting');
  assert.equal(byFeature.get('extract-template-from-pdf').category, 'extracting');
  // A scraped page turned into structured job attributes is extraction, even
  // though nothing was uploaded.
  assert.equal(byFeature.get('filter-google-sheet-job').category, 'extracting');

  assert.equal(byFeature.get('tailor-resume').category, 'building');
  assert.equal(byFeature.get('generate-cover-letter').category, 'building');

  // Nothing shipped falls into the unattached bucket: a feature added without
  // being categorised would show up here rather than quietly at the bottom of
  // the page.
  assert.equal(
    prompts.filter((p) => p.featureKey && p.category === 'other').length,
    0
  );
});

test('the label travels with the category, so the page is not a second copy of the list', async () => {
  const { staticDir } = useTempStorage('prompt-categories-labels');
  withShippedPrompts(staticDir);
  const { listPrompts } = loadFresh('../dist/services/promptService');
  const { listPromptCategories } = loadFresh('../dist/config/promptCategories');

  const labels = new Map(listPromptCategories().map((category) => [category.id, category.label]));
  assert.equal(labels.get('building'), 'Building Prompts');
  assert.equal(labels.get('extracting'), 'Extracting Prompts');

  for (const prompt of await listPrompts()) {
    assert.equal(prompt.categoryLabel, labels.get(prompt.category), prompt.id);
  }
});

test('extracting comes before building, because that is the order the app runs them', () => {
  useTempStorage('prompt-categories-order');
  const { listPromptCategories } = loadFresh('../dist/config/promptCategories');

  assert.deepEqual(
    listPromptCategories().map((category) => category.id),
    ['extracting', 'building', 'other']
  );
});

test('a custom prompt inherits the category of the feature it is attached to', async () => {
  const { staticDir } = useTempStorage('prompt-categories-custom');
  withShippedPrompts(staticDir);
  const service = loadFresh('../dist/services/promptService');

  const built = await service.createPrompt({
    name: 'My tailoring prompt',
    featureKey: 'tailor-resume',
    content: 'Tailor this.\n[[profileJson]]\n[[jobAnalysisJson]]',
  });
  assert.equal(built.category, 'building');
  assert.equal(built.categoryLabel, 'Building Prompts');

  const extracted = await service.createPrompt({
    name: 'My extraction prompt',
    featureKey: 'analyze-job-description',
    content: 'Analyze this.\n[[jobDescription]]',
  });
  assert.equal(extracted.category, 'extracting');

  // Derived, never stored. A stored category could disagree with the feature
  // the prompt actually runs as, and the failure would be a prompt filed under
  // Building that runs as an extractor.
  const listed = await service.listPrompts();
  assert.equal(listed.find((p) => p.id === built.id).category, 'building');
  assert.equal(listed.find((p) => p.id === extracted.id).category, 'extracting');
});

test('a prompt attached to no feature is unattached rather than guessed at', () => {
  useTempStorage('prompt-categories-unattached');
  const { categoryForFeature, getPromptCategory } = loadFresh('../dist/config/promptCategories');

  assert.equal(categoryForFeature(undefined), 'other');
  // Nothing runs it until a feature is chosen, and the label says so instead
  // of filing it under a category it does not belong to.
  assert.match(getPromptCategory('other').description, /nothing runs them/i);
});
