/**
 * Trial a recipe against a real org. This is how a candidate earns its "verified" entry.
 *
 * Three questions, each answered separately so a failure says where it failed:
 *   1. matched  - given only the trial step and the whole library, does Jev pick this recipe?
 *   2. ran      - does the run end "done", confirmed by the reviewer?
 *   3. held     - in a FRESH browser session, does the done-condition still hold? A change that was never
 *                 saved looks fine in the session that made it and is gone in the next one. Skipped for a
 *                 recipe whose effect is 'action': a compile or a recalculation leaves nothing to read back.
 *
 *   4. audited  - when the recipe names the Setup Audit Trail action it leaves, did Salesforce record it?
 *                 This one involves no model at all.
 *
 * Nothing is stamped automatically. A person reads the result and writes the "verified" entry.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { audited, setupAuditTrail, type AuditEntry } from './audit.js';
import { judgeClaims } from './check.js';
import { PlaywrightBrowser } from './browser.js';
import { frontdoorUrl } from './org.js';
import { planGoal } from './planner.js';
import { SALESFORCE } from './prompts.js';
import { chooseRecipe, recipePlan, type Recipe } from './recipes.js';
import { run } from './run.js';
import { verifyDone } from './verify.js';

export interface TrialResult {
  id: string;
  step: string;
  matched: { picked: string | null; probability: number | null; correct: boolean };
  ran: { status: string; verified: boolean; verifiedBy: 'audit' | 'page' | null; started: boolean; actions: number; jevRequests: number; inputTokens: number; elapsedMs: number; trace: string } | null;
  held: { done: boolean; reason: string } | null;
  audited: { expected: string | null; found: boolean; jev: number | null; entries: AuditEntry[] } | null;
  passed: boolean;
  error?: string;
}

export interface TrialOptions {
  org?: string;
  headless?: boolean;
  channel?: string;
  allowDestructive?: boolean;
  log?: (line: string) => void;
}

/** The audit command's judge: one claim alone, its proving entry, and whether a later entry undid it. */
async function judged(step: string, entries: AuditEntry[]): Promise<{ confirmed: boolean; probability: number }> {
  if (!entries.length) return { confirmed: false, probability: 0 };
  const [verdict] = (await judgeClaims([step], entries)).verdicts;
  return { confirmed: verdict.confirmed, probability: verdict.probability ?? 0 };
}

export async function trialRecipe(recipe: Recipe, library: Recipe[], options: TrialOptions = {}): Promise<TrialResult> {
  const log = options.log ?? (() => undefined);
  const step = recipe.trial?.step;
  if (!step) throw new Error(`recipes/${recipe.id}.json has no trial.step`);
  const result: TrialResult = { id: recipe.id, step, matched: { picked: null, probability: null, correct: false }, ran: null, held: null, audited: null, passed: false };
  const open = async (path: string) =>
    PlaywrightBrowser.open(await frontdoorUrl(options.org, path), {
      startPath: path, headless: options.headless ?? true, channel: options.channel, allowDestructive: options.allowDestructive,
    });
  try {
    const began = new Date();
    const match = await chooseRecipe(step, library);
    result.matched = { picked: match?.recipe.id ?? null, probability: match?.probability ?? null, correct: match?.recipe.id === recipe.id };
    log(`  matched: ${result.matched.correct ? 'yes' : `NO (picked ${result.matched.picked ?? 'NONE'})`}${match ? ` p=${match.probability.toFixed(2)}` : ''}`);

    // The run uses this recipe regardless, so a weak "when" does not hide whether the path itself works.
    const plan = recipePlan({ recipe, probability: match?.recipe.id === recipe.id ? match.probability : 0 }, step);
    const output = `artifacts/trials/${recipe.id}-${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`;
    const browser = await open(recipe.startPath);
    try {
      if (await browser.ensureRendered('/lightning/setup/SetupOneHome/home')) log(`  startPath did not render; started from Setup Home (fix the recipe)`);
      const ran = await run(browser, `${planGoal(plan)}\n\n${SALESFORCE}`, {
        output, plan, commit: plan.commit, returnTo: recipe.startPath,
        audit: options.org ? async () => judged(step, await setupAuditTrail(options.org!, began)) : undefined, allowDestructive: options.allowDestructive, log: (line) => log(`  ${line}`),
        verify: (page, history) => verifyDone(plan.doneWhen, page, { recentActions: history }),
      });
      result.ran = { status: ran.status, verified: ran.verified, verifiedBy: ran.verifiedBy, started: ran.started, actions: ran.actions, jevRequests: ran.jevRequests, inputTokens: ran.inputTokens, elapsedMs: ran.elapsedMs, trace: output };
    } finally {
      await browser.close();
    }
    if (result.ran.status === 'done' && result.ran.verified && recipe.effect === 'state') {
      const fresh = await open(recipe.trial?.checkPath ?? recipe.startPath);
      try {
        result.held = await verifyDone(plan.doneWhen, await fresh.observe(15_000, true), { freshSession: true });
      } finally {
        await fresh.close();
      }
      log(`  held in a fresh session: ${result.held.done ? 'yes' : 'NO'} - ${result.held.reason}`);
    }
    if (options.org) {
      const entries = await setupAuditTrail(options.org, began).catch(() => [] as AuditEntry[]);
      const jev = entries.length ? (await judged(step, entries).catch(() => null))?.probability ?? null : null;
      result.audited = { expected: recipe.audit ?? null, found: recipe.audit ? !!audited(entries, recipe.audit) : false, jev, entries };
      if (jev !== null) log(`  Jev, reading the audit trail: p=${jev.toFixed(2)} that it shows the step was done`);
      for (const e of entries) log(`  audit trail: ${e.action} - ${e.display.slice(0, 110)}`);
      if (recipe.audit) log(`  audited: ${result.audited.found ? 'yes' : `NO, expected "${recipe.audit}"`}`);
    }
    // An action is judged on having been started; a state on a reviewer's confirmation that also holds in a fresh session.
    const ranOk = result.ran?.status === 'done' && (result.ran.verified || result.ran.started);
    const auditOk = !recipe.audit || !options.org || !!result.audited?.found;
    // Salesforce's own record outranks a second look at the page. Seen live: a fresh session reopened a first-visit
    // intro overlay and could not see a change the audit trail had plainly recorded.
    const recorded = !!result.audited?.found || (result.audited?.jev ?? 0) >= 0.8;
    result.passed = result.matched.correct && ranOk && (recipe.effect === 'action' || !!result.held?.done || recorded) && auditOk;
  } catch (error) {
    result.error = (error as Error).message.split('\n')[0];
    log(`  error: ${result.error}`);
  }
  await mkdir('artifacts/trials', { recursive: true });
  await writeFile(`artifacts/trials/${recipe.id}.json`, JSON.stringify(result, null, 2));
  return result;
}
