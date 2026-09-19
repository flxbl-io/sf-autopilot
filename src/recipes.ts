/**
 * A library of tested procedures for Setup tasks that have no API.
 *
 * Live runs showed where this agent is weak and where it is strong: Jev executes a known path well, and the
 * wobble is in finding the way (a planner guessing a deep link, Jev torn between two search boxes). A recipe
 * removes the guessing. It is data, not code: where to start, the known UI path, what "done" looks like. The
 * step's own words still supply the specifics, so a recipe needs no parameter schema.
 *
 * Jev picks the recipe, or NONE. With no confident match, the free-form planner takes over.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { postJson } from './http.js';
import { validateChoice } from './jev.js';
import { safeStartPath, type Plan } from './planner.js';
import type { Post } from './types.js';

export interface Recipe {
  id: string;
  title: string;
  /** Read by Jev to decide whether a step is this procedure. Say what it is, and what it is not. */
  when: string;
  startPath: string;
  steps: string[];
  doneWhen: string;
  /** The procedure itself discards data or cannot be undone. The run still needs --allow-destructive. */
  destructive: boolean;
  /**
   * 'state': it leaves a setting that a later visit can read back. 'action': it starts something (a compile, a
   * recalculation) and leaves only a passing message, so there is nothing for a fresh session to re-check.
   */
  effect: 'state' | 'action';
  /**
   * For an action: the label of the control that fires it. Once that click is delivered and the page responds,
   * the run is over. It does not wait for the operation to finish (compiling a large org takes many minutes and
   * the page simply hangs until then), and it cannot click it twice.
   */
  commit?: string;
  /** Where the demand for an API is recorded, when known. Never invented. */
  idea: string | null;
  /** Only a live run earns an entry. An empty list means a candidate, not a tested recipe. */
  verified: { date: string; org: string; outcome: string }[];
  /**
   * The Setup Audit Trail action this procedure leaves behind (for example 'orgFiscalYearStartMonth'), learned
   * from a live run. When set, a trial passes only if Salesforce recorded it. Leave unset when Salesforce does
   * not audit the procedure.
   */
  audit?: string;
  /** A step to trial the recipe with, worded as a person would write it. checkPath: where a fresh session looks for the proof. */
  trial?: { step: string; checkPath?: string };
  /** Anything a maintainer should know: prerequisites, editions, doubts about API coverage. */
  notes?: string;
}

export const RECIPES_DIR = fileURLToPath(new URL('../../recipes/', import.meta.url));

export function loadRecipes(dir = RECIPES_DIR): Recipe[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const recipe = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as Recipe;
      const problem =
        recipe.id !== name.replace(/\.json$/, '') ? 'id must match the file name'
        : typeof recipe.title !== 'string' || typeof recipe.when !== 'string' || typeof recipe.doneWhen !== 'string' ? 'title, when and doneWhen are required'
        : safeStartPath(recipe.startPath) === null ? 'startPath must be a same-org /lightning/ path'
        : !Array.isArray(recipe.steps) || !recipe.steps.length || !recipe.steps.every((s) => typeof s === 'string') ? 'steps must be a non-empty list of strings'
        : typeof recipe.destructive !== 'boolean' ? 'destructive must be true or false'
        : !['state', 'action'].includes(recipe.effect) ? "effect must be 'state' or 'action'"
        : recipe.commit !== undefined && (recipe.effect !== 'action' || typeof recipe.commit !== 'string' || !recipe.commit.trim()) ? "commit is the firing control's label, and only an 'action' recipe has one"
        : !Array.isArray(recipe.verified) ? 'verified must be a list'
        : recipe.trial && (typeof recipe.trial.step !== 'string' || (recipe.trial.checkPath !== undefined && safeStartPath(recipe.trial.checkPath) === null)) ? 'trial needs a step, and checkPath must be a same-org /lightning/ path'
        : null;
      if (problem) throw new Error(`recipes/${name}: ${problem}`);
      return recipe;
    });
}

export interface RecipeMatch {
  recipe: Recipe;
  probability: number;
}

/** Below this, a match is a guess, and a guessed procedure is worse than a planned one. */
export const MATCH_THRESHOLD = 0.6;

export async function chooseRecipe(
  step: string,
  recipes: Recipe[],
  options: { post?: Post; apiKey?: string; onlyVerified?: boolean } = {},
): Promise<RecipeMatch | null> {
  const offered = recipes.filter((r) => !options.onlyVerified || r.verified.length > 0);
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!offered.length || !apiKey) return null;
  const criteria: Record<string, string> = Object.fromEntries(offered.map((r) => [r.id, `${r.title}. ${r.when}`]));
  criteria.NONE = 'None of these procedures is what the step asks for, or it is unclear which one is meant.';
  const base = (process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').replace(/\/$/, '');
  const result = await (options.post ?? postJson)(`${base}/systemone`, apiKey, {
    model: process.env.TYPESAFE_MODEL ?? 'jev-latest',
    state: { manual_step: step },
    questions: {
      recipe: {
        type: 'choice',
        criteria,
        instructions:
          'Which known Salesforce Setup procedure does `manual_step` ask for? Choose a procedure only when the step ' +
          'clearly asks for exactly that. A step that merely mentions the same area of Setup is NONE.',
      },
    },
  });
  const answer = validateChoice(result?.answers?.recipe, Object.keys(criteria));
  const probability = answer.probabilities[answer.choice];
  if (answer.choice === 'NONE' || probability < MATCH_THRESHOLD) return null;
  return { recipe: offered.find((r) => r.id === answer.choice)!, probability };
}

/** The recipe supplies the way; the step supplies the specifics. */
export function recipePlan(match: RecipeMatch, step: string): Plan {
  const { recipe, probability } = match;
  return {
    executable: true,
    reason: `Known procedure "${recipe.id}" (match ${probability.toFixed(2)}).`,
    startPath: safeStartPath(recipe.startPath),
    goal: `${step}\nThis is the known procedure "${recipe.title}". Follow its steps, using the names and values from the request above.`,
    steps: recipe.steps,
    doneWhen: `${recipe.doneWhen} Judge it against what was asked: ${step}`,
    commit: recipe.commit,
    audit: recipe.audit,
    model: `recipe:${recipe.id}`,
    latencyMs: 0,
  };
}
