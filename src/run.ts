/** The whole loop: observe -> Jev chooses operation + target -> (text LLM for TYPE_TEXT) -> Playwright executes. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Stale, type PlaywrightBrowser } from './browser.js';
import { DESTRUCTIVE, SALESFORCE_HOSTS } from './guards.js';
import { choose as jevChoose } from './jev.js';
import type { Plan } from './planner.js';
import { fieldContext, fieldText, type FieldContext, type TextResult } from './text.js';
import { ideaContext, type IdeaContext } from './ideas.js';
import type { Attachment, Decision, HistoryEntry, Page } from './types.js';
import type { Verdict } from './verify.js';

export { DESTRUCTIVE, SALESFORCE_HOSTS };

export interface RunOptions {
  choose?: (page: Page, goal: string, history: HistoryEntry[]) => Promise<Decision>;
  text?: (context: FieldContext) => Promise<TextResult>;
  /** Host suffixes the run may act on. null disables the guard (local fixtures only). */
  allowedHosts?: string[] | null;
  /** Checks a DONE before it counts. A rejection goes back to Jev as a note; two rejections end the run. */
  verify?: (page: Page, history: HistoryEntry[]) => Promise<Verdict>;
  /**
   * Ask Salesforce's Setup Audit Trail whether the step has been done. Checked beside the page reviewer, and
   * either can end the run. It is the stronger of the two: it does not depend on the page showing the proof,
   * which a Classic page that saves and lands on Setup Home never does.
   */
  audit?: () => Promise<{ confirmed: boolean; probability: number }>;
  /**
   * The label of the control that fires a long-running action. Delivering that click ends the run as done: the
   * click landed and the page responded. Whether the operation later succeeds is not something a browser
   * session can wait around to see.
   */
  commit?: string;
  /** Act even when the page warns of permanent data loss. Off by default: that is where a human belongs. */
  allowDestructive?: boolean;
  /**
   * Files the operator handed the run. Without any, file inputs are not offered to Jev at all. With them, a model
   * picks one by name from this list; the path it maps to never leaves this code.
   */
  files?: Attachment[];
  /**
   * Where the run began. Many Classic settings pages have no read-only view: Save sends the browser to Setup Home,
   * where nothing about the change is visible. Seen three times live. When that happens the loop goes back
   * here itself, so the saved value is on screen for the reviewer, rather than hoping Jev thinks to.
   */
  returnTo?: string;
  /**
   * Asked when the run is stuck (BLOCKED, a refused repeat, a covered target, unsure decisions): what on this page
   * might be worth trying. The answer is shown to Jev as ideas, never executed. Unset, the run gets no ideas.
   */
  ideas?: (context: IdeaContext) => Promise<string[]>;
  /**
   * Asked before a click that flips a checkbox, switch or radio whose state is known: should it end up checked?
   * true / false / null (the goal does not say). A click that would leave it the other way is refused.
   */
  toggle?: (label: string) => Promise<boolean | null>;
  /** Called before every action. Return false to stop. */
  confirm?: (step: Step) => Promise<boolean>;
  maxActions?: number;
  /** Folder for trace.json, last_observation.json and a screenshot per action. */
  output?: string;
  /** Recorded in the trace so a run can be judged against what was planned. */
  plan?: Plan;
  log?: (line: string) => void;
}

export interface Step {
  operation: string;
  target: string | null;
  confidence: number;
  topTargets: { label: string; probability: number }[];
  jevLatencyMs: number;
  /** The operation head's top three, so a trace shows what else Jev weighed. */
  topOperations?: { operation: string; probability: number }[];
  url: string;
  elements: number;
  text?: string;
  textLatencyMs?: number;
  delivered?: string;
  stale?: string;
  pageChanged?: boolean;
  /** Set on a DONE step: what the reviewer said. */
  verdict?: Verdict;
}

export interface RunResult {
  /** 'done' is the model's opinion, not proof. Verify the org's state independently. */
  status: string;
  /** true when the page reviewer or the audit trail confirmed it. */
  verified: boolean;
  /** Which one confirmed it. 'audit' is Salesforce's own record; 'page' is a model reading the screen. */
  verifiedBy: 'audit' | 'page' | null;
  /** true when the run ended because an action's firing click was delivered. Started, not known to have finished. */
  started: boolean;
  plan: Plan | null;
  goal: string;
  actions: number;
  jevRequests: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  steps: Step[];
  finalUrl: string;
}

export async function run(browser: PlaywrightBrowser, goal: string, options: RunOptions = {}): Promise<RunResult> {
  const choose = options.choose ?? jevChoose;
  const text = options.text ?? fieldText;
  const allowedHosts = options.allowedHosts === undefined ? SALESFORCE_HOSTS : options.allowedHosts;
  const maxActions = options.maxActions ?? 25;
  const log = options.log ?? (() => undefined);
  if (options.output) await mkdir(options.output, { recursive: true });

  const history: HistoryEntry[] = [];
  const steps: Step[] = [];
  const started = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let status = 'stopped: decision budget';
  let verified = false;
  let verifiedBy: 'audit' | 'page' | null = null;
  // Both checks at once. The audit trail wins when it confirms; otherwise the reviewer's words are what Jev hears.
  const judge = async (at: Page): Promise<Verdict & { by: 'audit' | 'page' | null }> => {
    const [record, seen] = await Promise.all([
      options.audit ? options.audit().catch(() => null) : null,
      options.verify ? options.verify(at, history) : null,
    ]);
    if (record?.confirmed) return { done: true, reason: `Salesforce's Setup Audit Trail records the change (Jev p=${record.probability.toFixed(2)}).`, by: 'audit' };
    if (seen?.done) return { ...seen, by: 'page' };
    return { done: false, reason: seen?.reason ?? 'The Setup Audit Trail does not show the change yet.', by: null };
  };
  const judged = !!(options.verify || options.audit);
  let actionStarted = false;
  let rejections = 0;
  let reviews = 0;
  let blockedOnce = false;
  let lastToggle: string | undefined;
  let retoggles = 0;
  let notes = '';
  const note = (reason: string) =>
    `\n\nA reviewer looked at the page after DONE was claimed and said: ${reason} If that is still true, resolve it. ` +
    'If it has since been resolved, DONE is correct.';
  const files = options.files ?? [];
  // No files, no upload targets: Jev cannot choose an operation that has nothing to attach.
  const offer = (at: Page): Page => (files.length ? at : { ...at, actions: at.actions.filter((a) => a.kind !== 'upload') });
  const uploaded = new Set<string>();
  // The nodes of the last few delivered actions, and how often each save-like control was pressed.
  const recentNodes: string[] = [];
  const saves = new Map<string, number>();
  let repeats = 0;
  let staleStreak = 0;
  // Ideas from a look at the page, for the next few decisions. Replaced, never piled up; capped, each is an LLM call.
  let ideasNote = '';
  let ideasLeft = 0;
  let ideaCalls = 0;
  let unsure = 0;
  const think = async (stuck: string, at: Page) => {
    if (!options.ideas || ideaCalls >= 6) return false;
    ideaCalls++;
    const ideas = await options.ideas(ideaContext(goal, stuck, at, history)).catch(() => []);
    if (!ideas.length) return false;
    ideasNote = `\n\nPossible next moves, read from this page because ${stuck}. Weigh them against what the page shows ` +
      `before choosing BLOCKED:\n` + ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n');
    ideasLeft = 3;
    log(`    ideas: ${ideas.join(' | ').slice(0, 300)}`);
    return true;
  };
  let scrolls = 0;
  /** history length after the last action that changed something: a form value, an upload, a save-like click. */
  let progressAt = 0;
  const progress = (a: { kind: string; label: string; role?: string }) =>
    ((a.kind === 'fill' && a.role !== 'searchbox' && !/search/i.test(a.label)) || a.kind === 'select' || a.kind === 'upload' ||
      (a.kind === 'click' && /\b(save|submit|activate|deactivate|delete|remove|add|assign|enable|disable|update|apply|confirm|new|done|ok)\b/i.test(a.label)));
  let page = offer(await browser.observe());

  try {
  for (let request = 0; request < maxActions * 2; request++) {
    if (page.blockedDialog) {
      status = `stopped: a browser dialog warned of permanent data loss and was cancelled ("${page.blockedDialog.slice(0, 160)}"); a human should decide`;
      break;
    }
    const host = new URL(page.url).hostname;
    if (allowedHosts && !allowedHosts.some((suffix) => host.endsWith(suffix))) {
      status = `stopped: left the org (${host})`;
      break;
    }
    const decision = await choose(page, goal + notes + (ideasLeft-- > 0 ? ideasNote : ''), history);
    inputTokens += decision.usage.input_tokens ?? 0;
    outputTokens += decision.usage.output_tokens ?? 0;
    const action = page.actions.find((a) => a.id === decision.choice);
    const labels = new Map(page.actions.map((a) => [a.id, a.label]));
    const ranked = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const step: Step = {
      operation: decision.operation,
      target: action?.label ?? null,
      confidence: decision.confidence,
      topTargets: ranked.map(([id, p]) => ({ label: labels.get(id) ?? id, probability: Math.round(p * 1000) / 1000 })),
      jevLatencyMs: decision.latencyMs,
      topOperations: Object.entries(decision.operationProbabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([operation, p]) => ({ operation, probability: Math.round(p * 1000) / 1000 })),
      url: page.url,
      elements: page.actions.length - 1,
    };
    steps.push(step);
    log(`${String(steps.length).padStart(2)}. ${step.operation.padEnd(9)} ${step.target ?? ''}  ` +
      `p=${(ranked[0]?.[1] ?? 0).toFixed(2)} conf=${step.confidence.toFixed(2)} ${step.jevLatencyMs} ms`);

    if (!action) {
      if (decision.choice !== 'DONE') {
        // Seen live: BLOCKED at confidence 0.18 on a pane that was merely blank while loading. One BLOCKED is
        // a reason to look again after a pause; only a second one in a row ends the run.
        if (blockedOnce) {
          status = 'blocked';
          break;
        }
        // A BLOCKED that yields fresh ideas does not count: Jev has not yet had the chance to try them.
        blockedOnce = !(await think('the agent saw no way forward', page));
        await browser.act({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
        await browser.act({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
        page = offer(await browser.observe());
        continue;
      }
      if (!judged) {
        status = 'done';
        break;
      }
      const verdict = (step.verdict = await judge(page));
      log(`    reviewer: ${verdict.done ? 'confirmed' : 'NOT done'} - ${verdict.reason}`);
      if (verdict.done) {
        status = 'done';
        verified = true;
        verifiedBy = verdict.by;
        break;
      }
      if (++rejections >= 2) {
        status = `unverified: ${verdict.reason}`;
        break;
      }
      notes = note(verdict.reason);
      page = offer(await browser.observe());
      continue;
    }
    if (!options.allowDestructive && DESTRUCTIVE.test(page.text)) {
      status = 'stopped: the page warns of permanent data loss; a human should decide (or pass allowDestructive)';
      break;
    }
    if (action.id === 'scroll' && ++scrolls > 20) {
      status = 'stopped: scrolled twenty times and the step still could not go on';
      break;
    }
    if (history.length >= maxActions) {
      status = `stopped: ${maxActions}-action budget`;
      break;
    }
    blockedOnce = false;
    // Two unsure decisions in a row: Jev is guessing. A look at the page may give it better options.
    if (decision.confidence < 0.4 && ++unsure >= 2 && ideasLeft <= 0) {
      unsure = 0;
      await think('the agent has been unsure of its last two choices', page);
    } else if (decision.confidence >= 0.4) unsure = 0;
    // Seen live: Jev unticked a checkbox, then ticked it again, 24 times, and never clicked Save. Each flip
    // changes the page, so the no-progress stop never fired. Flipping the toggle it has only just flipped undoes
    // its own work, so that choice is refused and Jev is told why; a second attempt ends the run.
    if (action.kind === 'click' && ['checkbox', 'radio', 'switch'].includes(action.role ?? '') && action.node === lastToggle) {
      if (++retoggles >= 2) {
        status = `stopped: kept toggling "${action.label.slice(0, 80)}" instead of moving on`;
        break;
      }
      step.stale = 'Refused: this toggle was only just changed; changing it again would undo that.';
      log(`    ${step.stale}`);
      notes += `\n\nYou have just changed "${action.label.slice(0, 80)}". Do not click it again: that would undo the change. If it is now in the requested state, click Save (or Submit).`;
      continue;
    }
    // Seen live: "Timeline Settings" clicked twelve times; every click redrew the page, so the no-progress stop
    // never fired. A third click in a row on one control is refused; paging through a list is the exception.
    if (action.kind === 'click' && recentNodes.length >= 2 && recentNodes.slice(-2).every((n) => n === action.node) &&
      !/\b(next|more|previous|prev)\b/i.test(action.label)) {
      if (++repeats >= 2) {
        status = `stopped: kept clicking "${action.label.slice(0, 80)}"`;
        break;
      }
      step.stale = 'Refused: this control was just clicked twice in a row; a third click would not help.';
      log(`    ${step.stale}`);
      notes += `\n\nYou have clicked "${action.label.slice(0, 80)}" twice in a row. Clicking it again will not help: choose a different control.`;
      await think(`it keeps clicking "${action.label.slice(0, 60)}"`, page);
      continue;
    }
    // Seen live: App Launcher, Conga Templates, the record, App Launcher again, round and round for the whole budget.
    // No single control repeats back to back, so the check above never fires. A label clicked three times in the
    // last twelve actions is a circle; it is refused, and a second refusal ends the run.
    // Only since the last real change: "deactivate these nine rules" rightly presses one Deactivate nine times.
    const base = (label: string) => label.replace(/\s*\(in frame:[^)]*\)\s*$/, '');
    const sinceProgress = history.slice(Math.max(progressAt, history.length - 12));
    if (action.kind === 'click' && !/\b(next|more|previous|prev)\b/i.test(action.label) &&
      sinceProgress.filter((h) => h.kind === 'click' && base(h.action) === base(action.label)).length >= 3) {
      if (++repeats >= 2) {
        status = `stopped: going round in circles through "${action.label.slice(0, 80)}"`;
        break;
      }
      step.stale = 'Refused: this control was already clicked three times recently; the run is going round in circles.';
      log(`    ${step.stale}`);
      notes += `\n\nYou have clicked "${action.label.slice(0, 80)}" three times already and are going round in circles. Do something different on the current page, or BLOCKED.`;
      await think(`it is going round in circles through "${action.label.slice(0, 60)}"`, page);
      continue;
    }
    // Seen live: a picklist edit saved four times over, because the reviewer wanted proof that page never shows.
    // Saving one form a third time is a loop, not progress; a person should look.
    // Keyed by the page as it stood: creating four folders rightly presses one Save four times, each on a new form.
    const saveKey = action.kind === 'click' && /\b(save|submit)\b/i.test(action.label) ? `${action.label}|${page.fingerprint}` : '';
    if (saveKey && (saves.get(saveKey) ?? 0) >= 2) {
      status = `stopped: "${action.label.slice(0, 80)}" was already pressed twice and the change is still not confirmed; a human should look`;
      break;
    }
    // A toggle already in the state the goal wants must not be clicked: that undoes the step. Jev's rules say so,
    // and Jev still did it once (seen live), so it is checked here too, before any input.
    const isToggle = action.kind === 'click' && ['checkbox', 'radio', 'switch'].includes(action.role ?? '') && ['true', 'false'].includes(action.checked ?? '');
    if (isToggle && options.toggle) {
      const wanted = await options.toggle(action.label);
      const after = action.role === 'radio' ? true : action.checked !== 'true';
      if (wanted !== null && wanted !== after) {
        if (++repeats >= 2) {
          status = `stopped: kept trying to ${after ? 'tick' : 'untick'} "${action.label.slice(0, 80)}", which the step wants ${wanted ? 'ticked' : 'unticked'}`;
          break;
        }
        step.stale = `Refused: "${action.label.slice(0, 60)}" is already ${wanted ? 'ticked' : 'unticked'}, as the step wants; clicking it would undo that.`;
        log(`    ${step.stale}`);
        notes += `\n\n"${action.label.slice(0, 80)}" is already ${wanted ? 'ticked' : 'unticked'}, which is what the step wants. Do not click it. Save if a change is pending, or DONE.`;
        continue;
      }
    }
    let value: string | undefined;
    if (action.kind === 'fill') {
      let written;
      try {
        written = await text(fieldContext(goal, action, page, history));
      } catch (error) {
        // The LLM had no value for this field (or named an option that does not exist). Nothing was typed, so
        // choosing again is safe. Seen live: it crashed a run that had merely picked the wrong field.
        if (!/nothing typed/.test((error as Error).message)) throw error;
        step.stale = (error as Error).message;
        log(`    ${step.stale}`);
        page = offer(await browser.observe());
        continue;
      }
      value = step.text = written.text;
      step.textLatencyMs = written.latencyMs;
      log(`    text: ${JSON.stringify(value)}`);
      // Seen live: "Flows" typed into Quick Find 25 times over. The same text into the same field a third time
      // running is refused, like a third click.
      const typed = history.slice(-2);
      if (typed.length === 2 && recentNodes.slice(-2).every((n) => n === action.node) && typed.every((h) => h.kind === 'fill' && h.text === value)) {
        if (++repeats >= 2) {
          status = `stopped: kept typing "${value.slice(0, 40)}" into "${action.label.slice(0, 60)}"`;
          break;
        }
        step.stale = 'Refused: this text was just typed into this field twice; typing it again would not help.';
        log(`    ${step.stale}`);
        notes += `\n\n"${value.slice(0, 40)}" is already typed into "${action.label.slice(0, 60)}". Do not type it again: click the matching result or link it produced.`;
        await think(`it keeps typing "${value.slice(0, 30)}"`, page);
        continue;
      }
    }
    let file: Attachment | undefined;
    if (action.kind === 'upload') {
      if (files.length === 1) file = files[0];
      else {
        const names = files.map((f) => f.name);
        try {
          const chosen = await text(fieldContext(goal, { ...action, kind: 'fill', options: names, label: `${action.label}: which of the provided files to attach` }, page, history));
          file = files.find((f) => f.name === chosen.text);
        } catch (error) {
          if (!/nothing typed/.test((error as Error).message)) throw error;
        }
        if (!file) {
          step.stale = 'No provided file was named for this upload; nothing was attached.';
          log(`    ${step.stale}`);
          page = offer(await browser.observe());
          continue;
        }
      }
      // An upload is a mutation: attaching the same file twice makes a second version or a duplicate record.
      const key = `${action.node}|${file.path}`;
      if (uploaded.has(key)) {
        step.stale = `Refused: "${file.name}" was already attached to this control in this run.`;
        log(`    ${step.stale}`);
        notes += `\n\n"${file.name}" has already been uploaded here. Do not upload it again; finish the step (for example click Done or Save).`;
        if (++retoggles >= 2) {
          status = `stopped: kept uploading "${file.name}" again`;
          break;
        }
        continue;
      }
      value = step.text = file.name;
      log(`    file: ${file.name}`);
    }
    if (options.confirm && !(await options.confirm(step))) {
      status = 'stopped: by operator';
      break;
    }
    try {
      step.delivered = await browser.act(action, value, file?.path);
      if (file && step.delivered.startsWith('upload')) uploaded.add(`${action.node}|${file.path}`);
      // A button that opened no picker was only a click: nothing was attached, so the history must not say it was.
      else if (file) value = undefined;
      recentNodes.push(action.node ?? action.id);
      staleStreak = 0;
      if (saveKey) saves.set(saveKey, (saves.get(saveKey) ?? 0) + 1);
    } catch (error) {
      if (!(error instanceof Stale)) throw error;
      // Thrown before any input was sent, so choosing again cannot repeat a mutation.
      step.stale = error.message;
      // Seen live: an App Builder dialog covered "Activation...", and Jev chose it forty times. Say what is wrong,
      // then stop: a target that stays covered needs a person, not a fiftieth request.
      if (++staleStreak >= 5) {
        status = `stopped: "${action.label.slice(0, 80)}" stayed unusable (${error.message})`;
        break;
      }
      if (staleStreak >= 2) notes += `\n\n"${action.label.slice(0, 80)}" cannot be used right now: ${error.message}. Something may cover it, such as an open dialog; deal with that first, or choose another control.`;
      if (staleStreak === 2) await think(`"${action.label.slice(0, 60)}" stays unusable: ${error.message}`, page);
      page = offer(await browser.observe());
      continue;
    }
    lastToggle = action.kind === 'click' && ['checkbox', 'radio', 'switch'].includes(action.role ?? '') ? action.node : undefined;
    history.push({ action: action.label, kind: action.kind, text: value ?? null, page_changed: null });
    if (progress(action)) progressAt = history.length;
    if (options.commit && action.kind === 'click' && action.label.toLowerCase().includes(options.commit.toLowerCase())) {
      // The firing click landed. Look once, briefly, for the record, then stop: no waiting, no second click.
      const after = await browser.observe(5000).then(offer).catch(() => page);
      history[history.length - 1].page_changed = step.pageChanged = after.fingerprint !== page.fingerprint;
      page = after;
      if (options.output) await browser.screenshot(join(options.output, `${String(history.length).padStart(2, '0')}.png`));
      if (page.blockedDialog) continue; // the top of the loop reports it and stops
      log(`    "${options.commit}" was clicked; not waiting for it to finish`);
      status = 'done';
      actionStarted = true;
      break;
    }
    // A Lightning tab draws its content after the tab strip has settled. Seen live: the Related tab was read with
    // its Files list still missing, and Jev said BLOCKED. After a tab, look patiently.
    let after = offer(await browser.observe(12_000, action.kind === 'click' && action.role === 'tab'));
    // Two shapes of the same thing, both seen live: the URL becomes Setup Home, or the URL stays put and the
    // embedded settings page simply disappears, leaving only the sidebar.
    const framed = (at: Page) => at.actions.some((a) => a.label.includes('(in frame:'));
    const wentHome = /\/SetupOneHome\//.test(after.url) && !/\/SetupOneHome\//.test(options.returnTo ?? '/SetupOneHome/');
    // Only after a save-like click. Seen live: 'Erase' replaced the embedded list with its confirmation step,
    // the loop took that for a dismissed settings page, reopened the start path, and abandoned the erase.
    const saving = /\b(save|submit|apply|update|ok)\b/i.test(action.label);
    const landedHome = !!options.returnTo && saving && (wentHome || (framed(page) && !framed(after)));
    if (landedHome && action.kind === 'click') {
      log(`    the settings page went away after that click; reopening ${options.returnTo} to see what was saved`);
      await browser.goto(options.returnTo!);
      after = offer(await browser.observe(15_000, true));
      history.push({ action: `Reopened ${options.returnTo} in a new page load, so what it shows now is what was saved`, kind: 'wait', text: null, page_changed: true });
    }
    history[history.length - (landedHome && action.kind === 'click' ? 2 : 1)].page_changed = step.pageChanged = after.fingerprint !== page.fingerprint;
    page = after;
    if (options.output) await browser.screenshot(join(options.output, `${String(history.length).padStart(2, '0')}.png`));

    // The reviewer looks after every click that changed the page, and ends the run itself. Jev cannot be relied
    // on to stop: seen live, it never claimed DONE after releasing the right component from a package, went
    // back, and released a second one. It also tends not to claim DONE again once corrected. Waiting for Jev to
    // say DONE is therefore waiting too long. Capped, because each look is an LLM call.
    if (judged && action.kind === 'click' && step.pageChanged && reviews < 12) {
      reviews++;
      const verdict = (step.verdict = await judge(page));
      log(`    reviewer: ${verdict.done ? 'confirmed' : 'not yet'} - ${verdict.reason}`);
      if (verdict.done) {
        status = 'done';
        verified = true;
        verifiedBy = verdict.by;
        break;
      }
      // Only a Jev that has claimed DONE is told what the reviewer thinks. Before that it is just noise.
      if (rejections > 0) notes = note(verdict.reason);
    }

    const recent = history.slice(-3);
    if (recent.length === 3 && recent.every((h) => h.page_changed === false && h.kind !== 'wait')) {
      status = 'blocked: three actions changed nothing';
      break;
    }
  }

  } catch (error) {
    // Input may or may not have been delivered. Never retry; stop, and keep the evidence.
    status = `error: ${(error as Error).message.split('\n')[0]}`;
  }

  const result: RunResult = {
    status,
    verified,
    verifiedBy,
    started: actionStarted,
    plan: options.plan ?? null,
    goal,
    actions: history.length,
    jevRequests: steps.length,
    inputTokens,
    outputTokens,
    elapsedMs: Math.round(performance.now() - started),
    steps,
    finalUrl: page.url,
  };
  if (options.output) {
    await writeFile(join(options.output, 'trace.json'), JSON.stringify(result, null, 2));
    await writeFile(join(options.output, 'last_observation.json'), JSON.stringify(page, null, 2));
    await browser.screenshot(join(options.output, 'final.png'));
  }
  return result;
}
