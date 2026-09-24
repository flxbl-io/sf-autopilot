#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { audited, setupAuditTrail, type AuditEntry } from './audit.js';
import { PlaywrightBrowser } from './browser.js';
import { auditCommand, judgeClaims } from './check.js';
import { attachments } from './files.js';
import { usage } from './http.js';
import { pageIdeas } from './ideas.js';
import { toggleIntent } from './text.js';
import { frontdoorUrl, orgContext } from './org.js';
import { planGoal, planStep, type Plan } from './planner.js';
import { SALESFORCE } from './prompts.js';
import { chooseRecipe, loadRecipes, recipePlan } from './recipes.js';
import { run } from './run.js';
import { trialRecipe } from './trial.js';
import type { Page } from './types.js';
import { verifyDone } from './verify.js';

const SETUP_HOME = '/lightning/setup/SetupOneHome/home';

const HELP = `sf-autopilot: hand it a Salesforce org and a manual step.

  sf-autopilot run      --org <alias> --step "<the step, as written for a human>"
  sf-autopilot plan     --step "<the step>" [--org <alias>]   the plan only; no browser, one LLM call (--org lets
                                                 it read the org's apps, tabs and packages)
  sf-autopilot diagnose --org <alias>            what is observable on the page; no model calls
  sf-autopilot audit    --org <alias> --step "<what should have happened>" [--since 30m|2h|1d] [--by <username>]
                        [--json] [--no-split]    did Salesforce record it? Checks what anyone did, by hand or by
                                                 agent; each claim in the prompt is judged on its own. No browser.
  sf-autopilot recipes                           the library of tested procedures
  sf-autopilot trial    --org <alias> [--only <id>]   run untested recipes' trial steps and re-check in a fresh session

  -o, --org <alias>       org alias or username known to the Salesforce CLI
  -s, --step <text>       the manual step          --step-file <path>   read it from a file
      --file <path>       a file the step may upload (repeatable)
      --files <dir>       offer the files under <dir> that the step names; repeatable, nearest folder first
                          (e.g. the runbook's own folder, then the repository)
      --raw               skip the planner; give Jev the step exactly as written
      --no-recipes        ignore the recipe library; always plan from scratch
      --candidates        let untested candidate recipes drive a run too (default: verified recipes only)
      --start-path <p>    override where the run begins (default: the plan's page, else Setup Home)
      --confirm           show the plan, then pause before every action
      --allow-destructive act even when the page warns of permanent data loss (default: stop for a human)
      --no-verify         accept Jev's DONE without an LLM review of the page
      --no-ideas          when stuck, do not ask the LLM what this page offers to try next
      --max-actions <n>   default 25
      --headless          no browser window
      --window <x,y,w,h>  place the visible browser window, in screen points (for watching or recording a run)
      --channel <name>    default chrome; "" uses Playwright's bundled Chromium
      --keep-open         leave the browser open when finished

An LLM plans the step and writes typed text (any OpenAI-compatible endpoint; Claude Sonnet by default).
Jev (TypeSafe) chooses every click. See .env.example. Makes paid model calls and sends page text to those
providers: use a scratch org or sandbox. DONE is the model's opinion, not proof.`;

/**
 * The run's own check uses the audit command's judge: one claim alone, the entry that proves it, and whether a
 * later entry undid it. So a change made and reverted inside one run is not confirmed here either.
 */
async function fromTrail(step: string, entries: AuditEntry[]): Promise<{ confirmed: boolean; probability: number; note: string | null }> {
  if (!entries.length) return { confirmed: false, probability: 0, note: null };
  const [verdict] = (await judgeClaims([step], entries)).verdicts;
  return { confirmed: verdict.confirmed, probability: verdict.probability ?? 0, note: verdict.note };
}

function placed(value: string | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!value) return undefined;
  const [x, y, width, height] = value.split(',').map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width < 400 || height < 300) throw new Error('--window takes x,y,width,height in screen points, e.g. 20,40,1200,700');
  return { x, y, width, height };
}

function diagnose(page: Page): void {
  for (const frame of page.stats) console.log(JSON.stringify(frame));
  console.log(`${page.actions.length - 1} controls across ${page.stats.length} frame(s)`);
  for (const a of page.actions.slice(0, 60)) {
    console.log(`  [${a.id}] ${a.kind.padEnd(6)} ${(a.role ?? '').padEnd(10)} ${a.label.slice(0, 90)}`);
  }
  console.log('walked > query_selector_all: controls live in shadow roots, and were reached.\n' +
    'closed_shadow_suspects > 0: components whose contents neither this reader nor Playwright can enter.');
}

function printPlan(plan: Plan): void {
  console.log(`Plan (${plan.model}, ${plan.latencyMs} ms)`);
  console.log(`  start: ${plan.startPath ?? 'Setup Home, then Quick Find'}`);
  console.log(`  goal:  ${plan.goal}`);
  plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`  done when: ${plan.doneWhen}`);
  console.log(`  audited as: ${plan.outcome ?? '(the step as written)'}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      org: { type: 'string', short: 'o' },
      step: { type: 'string', short: 's' },
      'step-file': { type: 'string' },
      file: { type: 'string', multiple: true },
      files: { type: 'string', multiple: true },
      raw: { type: 'boolean', default: false },
      'no-recipes': { type: 'boolean', default: false },
      candidates: { type: 'boolean', default: false },
      only: { type: 'string' },
      since: { type: 'string', default: '30m' },
      by: { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-split': { type: 'boolean', default: false },
      'start-path': { type: 'string' },
      confirm: { type: 'boolean', default: false },
      'allow-destructive': { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      'no-ideas': { type: 'boolean', default: false },
      'max-actions': { type: 'string', default: '25' },
      headless: { type: 'boolean', default: false },
      window: { type: 'string' },
      channel: { type: 'string', default: 'chrome' },
      'keep-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0] ?? '';
  if (command === 'recipes') {
    for (const r of loadRecipes()) {
      const stamp = r.verified.length ? `verified ${r.verified.at(-1)!.date}` : 'CANDIDATE, not yet run live';
      console.log(`${r.id.padEnd(38)} ${stamp}${r.destructive ? '  [destructive]' : ''}\n    ${r.title}`);
    }
    return;
  }
  if (command === 'audit') {
    // The check on its own. It does not care who did the step: an agent, or a person following a runbook.
    if (existsSync('.env')) process.loadEnvFile('.env');
    process.exitCode = await auditCommand({
      org: values.org, step: values.step ?? positionals.slice(1).join(' '), stepFile: values['step-file'],
      since: values.since, by: values.by, json: values.json, noSplit: values['no-split'],
    });
    return;
  }
  if (command === 'trial') {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const library = loadRecipes();
    const chosen = library.filter((r) => r.trial && (values.only ? r.id === values.only : r.verified.length === 0));
    if (!chosen.length) throw new Error(values.only ? `No recipe "${values.only}" with a trial step` : 'No untested recipe has a trial step');
    let failed = 0;
    for (const recipe of chosen) {
      console.log(`\n${recipe.id}: ${recipe.trial!.step}`);
      const t = await trialRecipe(recipe, library, { org: values.org, headless: true, channel: values.channel, allowDestructive: values['allow-destructive'], log: console.log });
      console.log(`  => ${t.passed ? 'PASSED' : 'FAILED'}  (${t.ran ? `${t.ran.status}, ${t.ran.actions} actions, ${Math.round(t.ran.elapsedMs / 1000)} s` : t.error ?? 'did not run'})`);
      if (!t.passed) failed++;
    }
    console.log(`\n${chosen.length - failed}/${chosen.length} passed. Results: artifacts/trials/. Nothing was stamped: read them, then add the "verified" entries.`);
    process.exitCode = failed ? 2 : 0;
    return;
  }
  if (values.help || !['run', 'plan', 'diagnose'].includes(command)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (existsSync('.env')) process.loadEnvFile('.env');

  const step = (values['step-file'] ? readFileSync(values['step-file'], 'utf8') : values.step ?? '').trim();
  if (command !== 'diagnose' && !step) throw new Error('Supply --step or --step-file');
  if (command === 'run' && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set');
  const provided = command === 'diagnose' ? [] : attachments(step, values.file, values.files);
  if (provided.length && command === 'run') console.log(`Files it may upload: ${provided.map((f) => f.name).join(', ')}\n`);

  let plan: Plan | undefined;
  if (command !== 'diagnose' && !values.raw) {
    // A tested procedure beats an invented one. Jev picks it; no confident match means plan from scratch.
    const match = values['no-recipes'] ? null : await chooseRecipe(step, loadRecipes(), { onlyVerified: !values.candidates });
    plan = match ? recipePlan(match, step) : await planStep(step, {}, provided.map((f) => f.name), values.org ? await orgContext(values.org) : undefined);
    if (command === 'plan') return console.log(JSON.stringify({ ...plan, usage }, null, 2));
    if (!plan.executable) {
      console.error(`Not a browser step: ${plan.reason}`);
      process.exit(3);
    }
    printPlan(plan);
  } else if (command === 'plan') {
    throw new Error('plan and --raw cannot be combined');
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string) => (await prompt.question(question)).trim() === '';
  let browser: PlaywrightBrowser | undefined;
  try {
    if (plan && values.confirm && !(await ask('Enter to open the org and begin, anything else to stop: '))) return;
    const startPath = values['start-path'] ?? plan?.startPath ?? SETUP_HOME;
    browser = await PlaywrightBrowser.open(await frontdoorUrl(values.org, startPath), {
      startPath,
      headless: values.headless,
      channel: values.channel,
      allowDestructive: values['allow-destructive'],
      window: placed(values.window),
    });
    if (command === 'diagnose') return diagnose(await browser.observe());
    if (await browser.ensureRendered(SETUP_HOME)) console.log(`  (${startPath} did not render; starting from Setup Home instead)\n`);

    const began = new Date();
    // The audit trail records results, not clicks: judge the step's outcome when the planner wrote one.
    const claim = plan?.outcome ?? step;
    const output = `artifacts/${began.toISOString().replace(/[-:]|\.\d+/g, '')}`;
    const result = await run(browser, `${plan ? planGoal(plan) : step}\n\n${SALESFORCE}`, {
      output,
      plan,
      commit: plan?.commit,
      returnTo: startPath,
      audit: values.org ? async () => fromTrail(claim, await setupAuditTrail(values.org!, began)) : undefined,
      allowDestructive: values['allow-destructive'],
      files: provided,
      ideas: values['no-ideas'] ? undefined : (context) => pageIdeas(context),
      toggle: (label) => toggleIntent(plan?.goal ?? step, label),
      verify: values['no-verify'] ? undefined : (page, history) => verifyDone(plan?.doneWhen || step, page, { recentActions: history }),
      maxActions: Number(values['max-actions']),
      log: console.log,
      confirm: values.confirm ? () => ask('    Enter to execute, anything else to stop: ') : undefined,
    });
    console.log(`\n${result.status}${result.verified ? (result.verifiedBy === 'audit' ? ' (confirmed by the Setup Audit Trail)' : ' (reviewer confirmed)') : result.started ? ' (action started; not waiting for it to finish)' : ''}: ${result.actions} actions, ${result.jevRequests} Jev requests ` +
      `(${result.inputTokens} in / ${result.outputTokens} out tokens), ${result.elapsedMs} ms. Trace: ${output}`);
    // The independent check: what did Salesforce itself record? No model and no page are involved.
    if (values.org) {
      try {
        const entries = await setupAuditTrail(values.org, began);
        writeFileSync(`${output}/audit.json`, JSON.stringify(entries, null, 2));
        console.log(entries.length ? '\nSetup Audit Trail (Salesforce\'s own record of this run):' : '\nSetup Audit Trail: no entries for this run. Salesforce does not audit every Setup action.');
        for (const e of entries) console.log(`  ${e.at.slice(11, 19)}  ${e.action.padEnd(30)} ${e.display.slice(0, 120)}`);
        if (plan?.audit && audited(entries, plan.audit)) console.log(`  => recorded "${plan.audit}", as this recipe expects.`);
        else if (plan?.audit) {
          // Seen live: the setting was already as asked, so Jev only clicked Save, the page looked right, and
          // Salesforce recorded nothing. "done" beside "treat as not done" told the person two things at once.
          console.log(result.verified
            ? `  => The page shows what was asked, but Salesforce recorded no "${plan.audit}" during this run: it was most likely already set before the run began. This run changed nothing.`
            : `  => EXPECTED "${plan.audit}" AND IT IS MISSING. Treat the step as not done.`);
          process.exitCode = 2;
        }
        if (entries.length) {
          const verdict = await fromTrail(claim, entries);
          writeFileSync(`${output}/audit-verdict.json`, JSON.stringify(verdict, null, 2));
          console.log(`  => Jev, reading that record: ${verdict.confirmed ? 'it CONFIRMS the step' : 'it does NOT confirm the step'} (p=${verdict.probability.toFixed(2)})${verdict.note ? `. ${verdict.note}` : ''}`);
          if (result.status === 'done' && !verdict.confirmed) process.exitCode = 2;
        }
      } catch (error) {
        console.log(`\n${(error as Error).message}`);
      }
    }
    // Measured, not estimated: every model call of this process, planning and the audit check included.
    writeFileSync(`${output}/usage.json`, JSON.stringify({ ...usage, elapsedMs: Date.now() - began.getTime(), status: result.status }, null, 2));
    console.log(`\nModel calls: Jev ${usage.jev.calls} (${usage.jev.inputTokens} in / ${usage.jev.outputTokens} out tokens), ` +
      `LLM ${usage.llm.calls} (${usage.llm.inputTokens} in / ${usage.llm.outputTokens} out tokens).`);
    if (values['keep-open']) await prompt.question('Browser left open for inspection. Enter to close: ');
    // A done run the audit trail contradicted has already set 2; a pipeline gating on the exit code must see it.
    if (process.exitCode !== 2) process.exitCode = result.status === 'done' ? 0 : 2;
  } finally {
    prompt.close();
    await browser?.close();
  }
}

main().catch((error: Error) => {
  // Seen live: `audit --json --bogus`, `--since` with no value and `--step "- a bulleted list"` die in parseArgs,
  // before auditCommand can keep its promise of one JSON object on stdout. A pipeline parsing stdout got nothing.
  const argv = process.argv.slice(2);
  if (argv.includes('audit') && argv.includes('--json')) console.log(JSON.stringify({ confirmed: false, error: error.message }, null, 2));
  else console.error(error.message);
  process.exit(1);
});
