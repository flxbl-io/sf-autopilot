/** The recipe library: every file is well-formed, Jev picks one or NONE, and a weak match falls back. No paid APIs. */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseRecipe, loadRecipes, MATCH_THRESHOLD, recipePlan } from '../src/recipes.js';
import { planGoal, safeStartPath } from '../src/planner.js';
import type { Post } from '../src/types.js';

const answering = (pick: string, probability: number, seen: any[] = []): Post => async (url, _key, body: any) => {
  seen.push({ url, body });
  const ids = Object.keys(body.questions.recipe.criteria);
  const rest = (1 - probability) / (ids.length - 1);
  return { answers: { recipe: { choice: pick, confidence: probability, probabilities: Object.fromEntries(ids.map((id) => [id, id === pick ? probability : rest])) } } };
};

test('every recipe on disk is well-formed, and none claims a verification it was not given', () => {
  const recipes = loadRecipes();
  assert.ok(recipes.length >= 2);
  for (const recipe of recipes) {
    assert.equal(safeStartPath(recipe.startPath), recipe.startPath, recipe.id);
    assert.ok(recipe.when.length > 80, `${recipe.id}: "when" must say what the procedure is and is not`);
    assert.ok(recipe.idea === null || /^https:\/\/ideas\.salesforce\.com\//.test(recipe.idea), `${recipe.id}: idea must be a real IdeaExchange link or null`);
    for (const v of recipe.verified) assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/, recipe.id);
  }
});

test('a malformed recipe file is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad', title: 't', when: 'w', doneWhen: 'd', startPath: 'https://evil.example/', steps: ['x'], destructive: false, effect: 'state', idea: null, verified: [] }));
  assert.throws(() => loadRecipes(dir), /recipes\/bad\.json: startPath must be a same-org/);
});

test('Jev picks the recipe in one request, and the step supplies the specifics', async () => {
  const seen: any[] = [];
  const recipes = loadRecipes();
  const step = 'After the refresh set deliverability to System email only';
  const match = await chooseRecipe(step, recipes, { apiKey: 'test', post: answering('email-deliverability', 0.93, seen) });
  assert.equal(match?.recipe.id, 'email-deliverability');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.state.manual_step, step);
  assert.ok('NONE' in seen[0].body.questions.recipe.criteria, 'NONE is always on offer');

  const plan = recipePlan(match!, step);
  assert.equal(plan.startPath, '/lightning/setup/OrgEmailSettings/home');
  assert.match(planGoal(plan), /^After the refresh set deliverability to System email only\n/);
  assert.match(plan.doneWhen, /Judge it against what was asked: After the refresh/);
  assert.equal(plan.model, 'recipe:email-deliverability');
});

test('NONE, a weak match, or no key all fall back to the planner', async () => {
  const recipes = loadRecipes();
  assert.equal(await chooseRecipe('Load accounts with Data Loader', recipes, { apiKey: 'test', post: answering('NONE', 0.9) }), null);
  assert.equal(await chooseRecipe('something about email', recipes, { apiKey: 'test', post: answering('email-deliverability', MATCH_THRESHOLD - 0.05) }), null);
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.equal(await chooseRecipe('x', recipes, { post: async () => assert.fail('must not call without a key') }), null);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test('onlyVerified keeps untested candidates out of a run', async () => {
  const seen: any[] = [];
  const candidate = { ...loadRecipes()[0], id: 'untested', verified: [] };
  await chooseRecipe('x', [candidate], { apiKey: 'test', onlyVerified: true, post: answering('NONE', 1, seen) });
  assert.equal(seen.length, 0, 'with nothing verified on offer, Jev is not even asked');
});

test('a trial block is validated, and untested recipes say why when they have no trial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  const base = { id: 'x', title: 't', when: 'w', doneWhen: 'd', startPath: '/lightning/setup/X/home', steps: ['s'], destructive: false, effect: 'state', idea: null, verified: [] };
  writeFileSync(join(dir, 'x.json'), JSON.stringify({ ...base, trial: { step: 'do it', checkPath: 'https://evil.example/' } }));
  assert.throws(() => loadRecipes(dir), /recipes\/x\.json: trial needs a step, and checkPath must be a same-org/);

  for (const recipe of loadRecipes()) {
    if (recipe.verified.length === 0 && !recipe.trial) {
      assert.match(recipe.notes ?? '', /Untested/, `${recipe.id}: a candidate with no trial step must say in notes why it cannot be trialled`);
    }
  }
});

test("only an action recipe may name a firing control", () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  const base = { id: 'x', title: 't', when: 'w', doneWhen: 'd', startPath: '/lightning/setup/X/home', steps: ['s'], destructive: false, idea: null, verified: [] };
  writeFileSync(join(dir, 'x.json'), JSON.stringify({ ...base, effect: 'state', commit: 'Save' }));
  assert.throws(() => loadRecipes(dir), /only an 'action' recipe has one/);
  for (const recipe of loadRecipes()) if (recipe.commit) assert.equal(recipe.effect, 'action', recipe.id);
});
