/** Jev makes every choice. One request asks for the operation and, speculatively, a target per operation. */

import { postJson } from './http.js';
import { NEXT_ACTION, TARGET } from './prompts.js';
import type { Action, ChoiceAnswer, Decision, HistoryEntry, Page, Post } from './types.js';

const OPERATIONS = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' } as const;
const LABELS: Record<string, string> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
};
const STATE_KEYS = ['role', 'checked', 'selected', 'expanded'] as const;

export interface Element {
  index: string;
  label: string;
  operations: string[];
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  options?: { index: string; label: string; value?: string }[];
}

export interface ActionSpace {
  elements: Element[];
  /** operation -> offered target index -> the observed action it would execute */
  targets: Record<string, Record<string, Action>>;
  controls: Record<string, Action>;
}

/** Typed output guarantees the interface, not the truth. Anything malformed executes nothing. */
export function validateChoice(answer: unknown, ids: string[]): ChoiceAnswer {
  const a = answer as ChoiceAnswer | undefined;
  const probabilities = a?.probabilities;
  const valid =
    !!a &&
    !!probabilities &&
    typeof probabilities === 'object' &&
    ids.includes(a.choice) &&
    Object.keys(probabilities).length === ids.length &&
    ids.every((id) => id in probabilities) &&
    [...Object.values(probabilities), a.confidence].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
    ) &&
    Math.abs(Object.values(probabilities).reduce((sum, n) => sum + n, 0) - 1) < 0.02 &&
    probabilities[a.choice] >= Math.max(...Object.values(probabilities)) - 1e-6;
  if (!valid) throw new Error('Invalid TypeSafe response; no action executed.');
  return a;
}

/** One index per observed element; each operation has its own valid target choices. */
export function actionSpace(actions: Action[]): ActionSpace {
  const elements: Element[] = [];
  const indices = new Map<string, string>();
  const targets: ActionSpace['targets'] = {};
  const controls: ActionSpace['controls'] = {};
  for (const action of actions) {
    if (action.kind === 'wait' || action.node === undefined) {
      controls[action.id.toUpperCase()] = action;
      continue;
    }
    if (!indices.has(action.node)) {
      const index = String(elements.length + 1);
      indices.set(action.node, index);
      const element: Element = { index, label: action.label.split(' → ')[0], operations: [] };
      for (const key of [...STATE_KEYS, 'value'] as const) if (action[key] !== undefined) element[key] = action[key];
      if (action.kind === 'select') {
        element.value = action.current_value ?? '';
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices.get(action.node)!;
    const element = elements[Number(index) - 1];
    const operation = OPERATIONS[action.kind];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (action.kind === 'select') {
      target = `${index}:${element.options!.length + 1}`;
      element.options!.push({ index: target, label: action.label, value: action.value });
    }
    (targets[operation] ??= {})[target] = action;
  }
  return { elements, targets, controls };
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'into', 'then', 'them', 'their', 'there', 'when', 'what', 'which',
  'page', 'click', 'step', 'steps', 'salesforce', 'setup', 'using', 'after', 'before', 'should', 'must', 'only', 'have']);

/**
 * Jev refuses a request that is too large (seen live: Sharing Settings lists rules and buttons for every object).
 * Keep the controls most likely to matter: those sharing words with the goal, then those on screen, in page order.
 */
const framed = (a: Action) => !String(a.node ?? '').startsWith('0:');

export function mostRelevant(actions: Action[], goal: string, keep: number): Action[] {
  const words = new Set((goal.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
  const controls = actions.filter((a) => a.node === undefined);
  const scored = actions
    .filter((a) => a.node !== undefined)
    .map((action, order) => {
      const label = action.label.toLowerCase();
      let score = 0;
      for (const word of words) if (label.includes(word)) score++;
      return { action, order, score };
    });
  const kept = new Set(
    // Ties go to the embedded Setup page over the sidebar and header around it, then to what is on screen.
    [...scored].sort((a, b) => b.score - a.score || Number(framed(b.action)) - Number(framed(a.action)) ||
      Number(b.action.in_viewport ?? false) - Number(a.action.in_viewport ?? false) || a.order - b.order)
      .slice(0, keep).map((s) => s.action),
  );
  return [...actions.filter((a) => kept.has(a)), ...controls];
}

/**
 * The most controls one Jev request carries. A long list is read whole (browser.ts); past this, the controls that
 * share words with the goal are kept, so the record a step names is never lost to where a page happens to end.
 */
export const TABLE_LIMIT = 250;

export interface ChooseOptions {
  post?: Post;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export async function choose(
  page: Page,
  goal: string,
  history: HistoryEntry[],
  options: ChooseOptions = {},
): Promise<Decision> {
  // At most TABLE_LIMIT controls, the most relevant when a page has more. If Jev says even that is too large, the
  // most relevant 120, then 60.
  for (const keep of [TABLE_LIMIT, 120, 60]) {
    const actions = page.actions.length - 1 <= keep ? page.actions : mostRelevant(page.actions, goal, keep);
    try {
      return await chooseFrom({ ...page, actions }, goal, history, options);
    } catch (error) {
      if (keep === 60 || !/max_tokens_exceeded/.test((error as Error).message)) throw error;
    }
  }
  throw new Error('unreachable');
}

async function chooseFrom(page: Page, goal: string, history: HistoryEntry[], options: ChooseOptions): Promise<Decision> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const { elements, targets, controls } = actionSpace(page.actions);

  const operations: Record<string, string> = {};
  for (const key of Object.keys(targets)) operations[key] = LABELS[key];
  for (const [key, control] of Object.entries(controls)) operations[key] = control.label;
  operations.DONE = 'Every requirement is visibly satisfied.';
  operations.BLOCKED = 'No supported operation can progress.';

  const questions: Record<string, unknown> = {
    operation: { type: 'choice', criteria: operations, instructions: { goal, rules: NEXT_ACTION } },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    const criteria: Record<string, unknown> = {};
    for (const [index, a] of Object.entries(candidates)) {
      const state: Record<string, unknown> = {};
      for (const key of STATE_KEYS) if (a[key] !== undefined) state[key] = a[key];
      criteria[index] = { element: `[${index}] ${a.label}`, current_value: a.current_value ?? a.value ?? '', ...state };
    }
    // Target heads cannot see the operation answer, so each one names the operation it assumes.
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }
  const body = {
    model: options.model ?? process.env.TYPESAFE_MODEL ?? 'jev-latest',
    state: {
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      recent_actions: history.slice(-10),
    },
    questions,
  };

  const base = (options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').replace(/\/$/, '');
  const started = performance.now();
  const result = await (options.post ?? postJson)(`${base}/systemone`, apiKey, body);
  const latencyMs = Math.round(performance.now() - started);

  const operationAnswer = validateChoice(result?.answers?.operation, Object.keys(operations));
  const operation = operationAnswer.choice;
  let target: string | null = null;
  let targetAnswer: ChoiceAnswer | null = null;
  let choice: string;
  const probabilities: Record<string, number> = {};
  if (operation in targets) {
    // Unused target heads cannot cause an action. Validate only the head the operation selected.
    const candidates = targets[operation];
    targetAnswer = validateChoice(result.answers[`${operation.toLowerCase()}_target`], Object.keys(candidates));
    target = targetAnswer.choice;
    choice = candidates[target].id;
    for (const [index, a] of Object.entries(candidates)) probabilities[a.id] = targetAnswer.probabilities[index];
  } else {
    choice = operation in controls ? controls[operation].id : operation;
    probabilities[choice] = operationAnswer.probabilities[operation];
  }
  return {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    probabilities,
    operationProbabilities: operationAnswer.probabilities,
    targetConfidence: targetAnswer?.confidence ?? null,
    model: result.model,
    usage: result.usage ?? {},
    latencyMs,
  };
}
