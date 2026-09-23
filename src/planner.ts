/** A step written for a human becomes a plan a browser agent can act on. One LLM call, before any browser opens. */

import { chatJson, type LlmOptions } from './llm.js';
import { PLAN } from './prompts.js';

export interface Plan {
  /** false when the step needs something outside the browser UI, or is too vague to act on safely. */
  executable: boolean;
  reason: string;
  /** A Setup deep link, only when the planner is confident it exists. Otherwise the agent uses Quick Find. */
  startPath: string | null;
  /** One precise paragraph for Jev: exact labels, names and values taken from the step. */
  goal: string;
  steps: string[];
  /** Visible evidence that proves completion. */
  doneWhen: string;
  /**
   * The step as a past-tense change to the org, for the Setup Audit Trail check. Seen live: judged against the
   * step as written ("Go to My Domain... click Edit... then Save"), Jev gave p=0.64 to an entry that plainly
   * recorded it; against "Microsoft SSO was added to the My Domain login page", p=0.93. Unset when absent or
   * when it lost a value the step gives, and the step itself is judged instead.
   */
  outcome?: string;
  /** Set by an 'action' recipe: the label of the control that fires it. That click ends the run. */
  commit?: string;
  /** Set by a recipe: the Setup Audit Trail action Salesforce is expected to record. */
  audit?: string;
  model: string;
  latencyMs: number;
}

/** A model wrote this path, and it is about to be opened in a signed-in admin session. Same-org paths only. */
export function safeStartPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^\/lightning\/[A-Za-z0-9_\-./?=&%]*$/.test(value) && !value.includes('..') && !value.includes('//')
    ? value
    : null;
}

/**
 * A model rewrote the step, and a rewrite that drops "to April" is one any fiscal-year entry confirms. So the
 * values a step spells out (quoted text, URLs, email addresses, numbers) must all survive into the outcome, or
 * the outcome is not used. It cannot catch an unquoted value reworded; the step is then judged, as before.
 */
export function keepsValues(step: string, outcome: string): boolean {
  const values = [
    ...[...step.matchAll(/["'“‘]([^"'”’]{2,})["'”’]/g)].map((m) => m[1]),
    ...(step.match(/https?:\/\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[\w./-]*\d[\w./-]*\b/g) ?? []),
  ].map((v) => v.replace(/[.,;:)]+$/, '').toLowerCase().trim()).filter(Boolean);
  const text = outcome.toLowerCase();
  return values.every((v) => text.includes(v));
}

export async function planStep(step: string, options: LlmOptions = {}): Promise<Plan> {
  const reply = await chatJson(PLAN, JSON.stringify({ manual_step: step }), options);
  const { executable, reason, startPath, goal, steps, doneWhen, outcome } = reply.json;
  const valid =
    typeof executable === 'boolean' &&
    typeof reason === 'string' &&
    (executable === false ||
      (typeof goal === 'string' && goal.trim() !== '' &&
        Array.isArray(steps) && steps.length > 0 && steps.length <= 12 && steps.every((s) => typeof s === 'string') &&
        typeof doneWhen === 'string'));
  if (!valid) throw new Error('Planner returned an invalid plan; nothing executed.');
  return {
    executable: executable as boolean,
    reason: reason as string,
    startPath: safeStartPath(startPath),
    goal: typeof goal === 'string' ? goal.trim() : '',
    steps: Array.isArray(steps) ? (steps as string[]) : [],
    doneWhen: typeof doneWhen === 'string' ? doneWhen : '',
    outcome: typeof outcome === 'string' && outcome.trim() && keepsValues(step, outcome) ? outcome.trim() : undefined,
    model: reply.model,
    latencyMs: reply.latencyMs,
  };
}

/** What Jev reads on every decision. */
export function planGoal(plan: Plan): string {
  return [
    plan.goal,
    'Plan:',
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    `Done when: ${plan.doneWhen}`,
  ].join('\n');
}
