#!/usr/bin/env node
/**
 * The evaluation of `sf-autopilot audit` against real models. NOT part of `npm test`: every case is a paid Jev
 * request, and a prompt with several parts is a paid LLM request as well. See docs/audit-command-evaluation.md.
 *
 *   npm run build
 *   export TYPESAFE_API_KEY=... ANTHROPIC_API_KEY=...          (never on the command line, never in a file here)
 *   node scripts/audit-eval.mjs --mode snapshot                  judge eval/trail-*.json through src/check.ts; no org needed
 *   node scripts/audit-eval.mjs --mode live                      every case through the real CLI, against the real org
 *   node scripts/audit-eval.mjs --mechanics                      exit codes and --json hygiene of the CLI; needs the org
 *
 *   --cases <file>      default eval/audit-cases.json
 *   --only <text>       only cases whose id or category starts with this
 *   --no-split          judge every prompt whole (to see what the LLM split changes)
 *   --runs <n>          run every case n times (default 1)
 *   --concurrency <n>   default 4
 *   --out <file>        where the results go; default eval/results/<mode>-<time>.json (usernames are masked)
 *   --cap-org <alias>   --mechanics only: an org with more than 200 entries in 180 days, to see the read cap
 *
 * Snapshot mode sends Jev byte-for-byte what live mode sends (a username is never part of the request), and also
 * keeps Jev's raw answers, so only it can show what the entry pick would have said below the threshold.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/src/cli.js');
const SNAPSHOT = resolve(ROOT, 'eval/trail-sf-autopilot-test-2026-09-19.json');

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'snapshot' },
    cases: { type: 'string', default: resolve(ROOT, 'eval/audit-cases.json') },
    only: { type: 'string' },
    'no-split': { type: 'boolean', default: false },
    runs: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string' },
    mechanics: { type: 'boolean', default: false },
    'cap-org': { type: 'string' },
  },
});

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const fmt = (p) => (p === null || p === undefined ? ' ?  ' : p.toFixed(2));

/** Runs the real CLI. No shell, so a prompt full of quotes and dollar signs reaches it as typed. */
function cli(argv, { env = process.env, cwd = tmpdir() } = {}) {
  return new Promise((done) => {
    // cwd is a temp directory so that a developer's .env cannot quietly supply a key the test took away.
    const child = spawn(process.execPath, [CLI, ...argv], { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** stdout must be exactly one JSON object: what a pipeline would hand to a JSON parser. */
function oneObject(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

// ---------------------------------------------------------------------------------------------- mechanics

async function mechanics() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set');
  const org = 'sf-autopilot-test';
  const base = ['audit', '--org', org, '--json'];
  const step = ['--step', 'Expire all passwords for every user in the org'];
  const without = (...keys) => Object.fromEntries(Object.entries(process.env).filter(([k]) => !keys.includes(k)));
  /** [name, argv, expected exit code, options, a check on the parsed object] */
  const checks = [
    ['--since 0 is refused', [...base, ...step, '--since', '0'], 1, {}, (o) => /--since takes/.test(o.error)],
    ['--since 30 (bare minutes)', [...base, ...step, '--since', '30'], [0, 2], {}, (o) => o.minutes === 30],
    ['--since 45m', [...base, ...step, '--since', '45m'], [0, 2], {}, (o) => o.minutes === 45],
    ['--since 2h', [...base, ...step, '--since', '2h'], [0, 2], {}, (o) => o.minutes === 120],
    ['--since 1d', [...base, ...step, '--since', '1d'], [0, 2], {}, (o) => o.minutes === 1440],
    ['--since 180d (the longest allowed)', [...base, ...step, '--since', '180d'], [0, 2], {}, (o) => o.minutes === 180 * 1440],
    ['--since 181d is refused', [...base, ...step, '--since', '181d'], 1, {}, (o) => /at most 180d/.test(o.error)],
    ['--since 999999d is refused', [...base, ...step, '--since', '999999d'], 1, {}, (o) => /--since takes/.test(o.error)],
    ['--since garbage is refused', [...base, ...step, '--since', 'yesterday'], 1, {}, (o) => /Got "yesterday"/.test(o.error)],
    ['--since 1.5h is refused', [...base, ...step, '--since', '1.5h'], 1, {}, (o) => /--since takes/.test(o.error)],
    ['--since -5 is refused', [...base, ...step, '--since=-5'], 1, {}, (o) => /--since takes/.test(o.error)],
    ['--since "" is refused', [...base, ...step, '--since', ''], 1, {}, (o) => /--since takes/.test(o.error)],
    ['--since with no value', [...base, ...step, '--since'], 1, {}, (o) => typeof o.error === 'string'],
    ['an unknown flag', [...base, ...step, '--bogus'], 1, {}, (o) => typeof o.error === 'string'],
    ['a bulleted prompt after --step (starts with a dash)', [...base, '--step', '- expire all passwords'], 1, {}, (o) => /--step=/.test(o.error)],
    ['the same with --step=', [...base, '--since', '180d', '--step=- expire all passwords'], [0, 2], {}, (o) => o.prompt === '- expire all passwords'],
    ['a bad org alias', ['audit', '--org', 'no-such-org-alias', '--json', ...step], 1, {}, (o) => /Could not read the Setup Audit Trail/.test(o.error)],
    ['no --org', ['audit', '--json', ...step], 1, {}, (o) => /Supply --org/.test(o.error)],
    ['an empty prompt', [...base, '--step', ''], 1, {}, (o) => /what should have happened/.test(o.error)],
    ['a whitespace prompt', [...base, '--step', ' \n\t '], 1, {}, (o) => /what should have happened/.test(o.error)],
    ['no prompt at all', [...base], 1, {}, (o) => /what should have happened/.test(o.error)],
    ['a --step-file that does not exist', [...base, '--step-file', '/nonexistent/steps.md'], 1, {}, (o) => typeof o.error === 'string'],
    ['--by "" (an unset shell variable)', [...base, ...step, '--since', '180d', '--by', ''], 1, {}, (o) => /--by/.test(o.error)],
    ['no TYPESAFE_API_KEY', [...base, ...step, '--since', '180d'], 1, { env: without('TYPESAFE_API_KEY') }, (o) => o.error === 'TYPESAFE_API_KEY is not set'],
    ['no LLM key: judged whole, and says so', [...base, '--since', '180d', '--step', 'Expire all passwords and permanently delete Autopilot Trial Field'], [0, 2],
      { env: without('ANTHROPIC_API_KEY', 'LLM_API_KEY') }, (o) => o.split === 'none' && o.notes.some((n) => /not split/.test(n))],
    ['an empty window judges nothing', [...base, ...step, '--since', '1'], 2, {}, (o) => o.confirmed === false && o.entries.length === 0 && o.claims[0].probability === null],
    ['the prompt as the last argument', [...base, '--since', '180d', 'Expire all passwords for every user in the org'], [0, 2], {}, (o) => o.prompt.startsWith('Expire all')],
  ];
  if (args['cap-org']) {
    checks.push(['180 days of a busy org: the read is capped, and says so', ['audit', '--org', args['cap-org'], '--json', '--since', '180d', ...step], [0, 2], {},
      (o) => o.entries.length === 200 && o.notes.some((n) => /200 entries/.test(n))]);
  }

  let failed = 0;
  const rows = await pool(checks, 3, async ([name, argv, want, options, check]) => {
    const { code, stdout, stderr } = await cli(argv, options);
    const object = oneObject(stdout);
    const problems = [];
    if (![want].flat().includes(code)) problems.push(`exit ${code}, wanted ${[want].flat().join(' or ')}`);
    if (!object) problems.push(`stdout is not one JSON object (${stdout.length} bytes${stdout ? `: ${JSON.stringify(stdout.slice(0, 80))}` : ''}; stderr: ${JSON.stringify(stderr.slice(0, 120))})`);
    else {
      if (typeof object.confirmed !== 'boolean') problems.push('no boolean "confirmed"');
      if ((code === 0) !== (object.confirmed === true)) problems.push(`exit ${code} but confirmed=${object.confirmed}`);
      if ((code === 1) !== (typeof object.error === 'string')) problems.push(`exit ${code} but error=${JSON.stringify(object.error)}`);
      if (!check(object)) problems.push(`unexpected content: ${JSON.stringify(object.error ?? object.notes ?? object).slice(0, 160)}`);
    }
    return { name, code, problems };
  });
  // Without --json an error goes to stderr, and stdout carries no verdict.
  for (const [name, argv] of [['plain: bad --since', ['audit', '--org', org, ...step, '--since', 'soon']], ['plain: bad org', ['audit', '--org', 'no-such-org-alias', ...step]]]) {
    const { code, stdout, stderr } = await cli(argv);
    const problems = [];
    if (code !== 1) problems.push(`exit ${code}, wanted 1`);
    if (/CONFIRMED/.test(stdout)) problems.push('a verdict was printed');
    if (!stderr.trim()) problems.push('nothing on stderr');
    rows.push({ name, code, problems });
  }
  for (const row of rows) {
    if (row.problems.length) failed++;
    console.log(`${row.problems.length ? 'FAIL' : 'ok  '}  exit ${row.code}  ${row.name}${row.problems.map((p) => `\n        ${p}`).join('')}`);
  }
  console.log(`\n${rows.length - failed}/${rows.length} mechanics checks passed.`);
  process.exitCode = failed ? 2 : 0;
}

// ---------------------------------------------------------------------------------------------- the cases

/** `sf data query` over the snapshot: the same WHERE, ORDER BY and LIMIT the command asks Salesforce for. */
function snapshotExec(snapshot) {
  return (_file, argv, done) => {
    const soql = argv[argv.indexOf('--query') + 1];
    const from = /CreatedDate >= (\S+)/.exec(soql)?.[1];
    const descending = /ORDER BY CreatedDate DESC/i.test(soql);
    const limit = Number(/LIMIT (\d+)/i.exec(soql)?.[1] ?? Infinity);
    if (!from) return done(null, JSON.stringify({ status: 1, message: `snapshot: no CreatedDate filter in ${soql}` }));
    const records = snapshot.entries
      .filter((e) => new Date(e.at.replace('+0000', 'Z')) >= new Date(from))
      .sort((a, b) => (descending ? -1 : 1) * a.at.localeCompare(b.at))
      .slice(0, limit)
      .map((e) => ({ CreatedDate: e.at, Action: e.action, Section: e.section, Display: e.display, CreatedBy: e.by ? { Username: e.by } : null }));
    return done(null, JSON.stringify({ status: 0, result: { records } }));
  };
}

const USER = (by, username) => by
  ?.replaceAll('{user}', username)
  .replaceAll('{USER}', username.toUpperCase())
  .replaceAll('{userLocalPart}', username.split('@')[0]);

async function runCases() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set');
  if (!['live', 'snapshot'].includes(args.mode)) throw new Error('--mode is live or snapshot');
  const file = JSON.parse(readFileSync(args.cases, 'utf8'));
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const { checkPrompt } = await import(resolve(ROOT, 'dist/src/check.js'));
  const { setupAuditTrail } = await import(resolve(ROOT, 'dist/src/audit.js'));
  const { postJson } = await import(resolve(ROOT, 'dist/src/http.js'));

  let cases = file.cases.filter((c) => !args.only || c.id.startsWith(args.only) || c.category.startsWith(args.only));
  cases = Array.from({ length: Number(args.runs) }, (_, run) => cases.map((c) => ({ ...c, run }))).flat();
  if (args.mode === 'snapshot' && cases.some((c) => c.org !== snapshot.org)) throw new Error(`Snapshot mode only knows ${snapshot.org}`);

  // Who made the changes, so that --by cases can name them. Live: whoever the org says; never written to disk.
  const usernames = {};
  const started = new Date();
  for (const org of new Set(cases.map((c) => c.org))) {
    if (args.mode === 'snapshot') {
      usernames[org] = 'user@example.com';
      continue;
    }
    const live = await setupAuditTrail(org, new Date(Date.now() - 36 * 3600_000));
    const counts = {};
    for (const e of live) if (e.by) counts[e.by] = (counts[e.by] ?? 0) + 1;
    usernames[org] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'nobody@example.com';
    if (org === snapshot.org) {
      // The labels describe the snapshot. If the org has moved on since, some labels may no longer be the truth.
      const key = (e) => `${e.at}|${e.action}|${e.display}`;
      const known = new Set(snapshot.entries.map(key));
      const fresh = live.filter((e) => e.at >= snapshot.entries[0].at && !known.has(key(e)));
      if (fresh.length) {
        console.log(`WARNING: ${org} has ${fresh.length} entr${fresh.length === 1 ? 'y' : 'ies'} the snapshot does not. Labels may be stale:`);
        for (const e of fresh) console.log(`  ${e.at}  ${e.action}  ${e.display.slice(0, 100)}`);
      }
    }
  }

  const results = await pool(cases, Number(args.concurrency), async (c) => {
    const from = c.window ? new Date(file.windows[c.window]) : null;
    if (c.window && !file.windows[c.window]) throw new Error(`${c.id}: unknown window ${c.window}`);
    const now = args.mode === 'snapshot' ? new Date(snapshot.now) : new Date();
    const since = from ? String(Math.ceil((now.getTime() - from.getTime()) / 60_000)) : c.since;
    const by = USER(c.by, usernames[c.org]);
    const noSplit = args['no-split'] || c.noSplit;
    const began = performance.now();
    let report;
    let problems = [];
    const raw = [];
    if (args.mode === 'live') {
      // --step=... and not --step ...: a prompt that is a bulleted list starts with a dash, which parseArgs refuses
      // as an ambiguous option (seen live on multi3-04). --mechanics covers that refusal.
      const argv = ['audit', '--org', c.org, '--json', '--since', since, `--step=${c.prompt}`];
      if (by !== undefined) argv.push('--by', by);
      if (noSplit) argv.push('--no-split');
      const { code, stdout } = await cli(argv);
      report = oneObject(stdout);
      if (!report) problems.push(`stdout is not one JSON object: ${JSON.stringify(stdout.slice(0, 120))}`);
      else if ((code === 0) !== (report.confirmed === true) || (code === 1) !== (typeof report.error === 'string')) problems.push(`exit ${code} does not match the object`);
      report ??= { error: 'unparseable output' };
    } else {
      try {
        report = await checkPrompt({ org: c.org, step: c.prompt, since, by, noSplit }, {
          exec: snapshotExec(snapshot),
          now: () => now,
          post: async (url, key, body) => {
            const reply = await postJson(url, key, body);
            if (url.endsWith('/systemone')) raw.push(reply?.answers ?? null);
            return reply;
          },
        });
      } catch (error) {
        report = { error: error.message };
      }
    }
    const answers = raw.at(-1) ?? null;
    const claims = (report.claims ?? []).map((v, i) => ({
      claim: v.claim,
      probability: v.probability,
      confirmed: v.confirmed,
      entry: v.entry ? `${v.entry.at.slice(11, 19)} ${v.entry.action}: ${v.entry.display.slice(0, 90)}` : null,
      entryProbability: v.entryProbability,
      note: v.note,
      // Jev's pick whatever the probability was: the command only reads it above the threshold.
      rawPick: answers?.[`claim_${i + 1}_entry`]?.choice ?? null,
      rawPickProbability: answers?.[`claim_${i + 1}_entry`]?.probabilities?.[answers?.[`claim_${i + 1}_entry`]?.choice] ?? null,
      // Jev's probability that a later entry undid the change; the command reads it only for a likely claim.
      undone: v.undone ?? null,
      rawUndone: answers?.[`claim_${i + 1}_undone`]?.noul ?? null,
    }));
    // The username in every spelling a case may have used, its local part last so the whole name goes first.
    const spellings = [usernames[c.org], usernames[c.org].toUpperCase(), usernames[c.org].split('@')[0]];
    const mask = (text) => (typeof text === 'string' ? spellings.reduce((t, name) => t.replaceAll(name, name.includes('@') ? 'user@example.com' : 'user'), text) : text);
    return {
      id: c.id, run: c.run, category: c.category, repeatOf: c.repeatOf ?? null, window: c.window ?? null, prompt: c.prompt, expected: c.expected,
      got: report.error ? 'ERROR' : report.confirmed ? 'CONFIRMED' : 'NOT_CONFIRMED',
      error: mask(report.error) ?? null,
      // A prompt is only as likely as its least likely claim; a claim that was not judged scores 0.
      score: claims.length ? Math.min(...claims.map((v) => v.probability ?? 0)) : 0,
      split: report.split ?? null, entries: report.entries?.length ?? null, shown: report.shown ?? null,
      claims, notes: (report.notes ?? []).map(mask), problems, ms: Math.round(performance.now() - began),
    };
  });

  print(results, file);
  const out = args.out ?? resolve(ROOT, `eval/results/${args.mode}${args['no-split'] ? '-nosplit' : ''}-${started.toISOString().replace(/[-:]|\.\d+/g, '')}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ mode: args.mode, noSplit: args['no-split'], startedAt: started.toISOString(), cases: args.cases.replace(`${ROOT}/`, ''), results }, null, 2)}\n`);
  console.log(`\nResults: ${out}`);
}

// ---------------------------------------------------------------------------------------------- the report

function histogram(scores) {
  const buckets = Array(10).fill(0);
  for (const s of scores) buckets[Math.min(9, Math.floor(s * 10))]++;
  return buckets.map((n, i) => `  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  ${String(n).padStart(3)}  ${'#'.repeat(n)}`).join('\n');
}

const quantiles = (scores) => {
  const s = [...scores].sort((a, b) => a - b);
  const q = (f) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2) : 'n/a');
  return `n=${s.length} min=${q(0)} p10=${q(0.1)} median=${q(0.5)} p90=${q(0.9)} max=${s.length ? s.at(-1).toFixed(2) : 'n/a'}`;
};

function print(results, file) {
  const should = results.filter((r) => r.expected === 'CONFIRMED');
  const shouldNot = results.filter((r) => r.expected === 'NOT_CONFIRMED');
  const count = (rows, got) => rows.filter((r) => r.got === got).length;
  const right = results.filter((r) => r.got === r.expected);

  console.log(`\n${results.length} runs of ${new Set(results.map((r) => r.id)).size} cases (${file.cases.length} in the file). Correct: ${right.length} (${pct(right.length, results.length)})\n`);
  console.log('CONFUSION MATRIX            got CONFIRMED   got NOT_CONFIRMED   got ERROR');
  console.log(`  expected CONFIRMED        ${String(count(should, 'CONFIRMED')).padStart(13)}   ${String(count(should, 'NOT_CONFIRMED')).padStart(17)}   ${String(count(should, 'ERROR')).padStart(9)}`);
  console.log(`  expected NOT_CONFIRMED    ${String(count(shouldNot, 'CONFIRMED')).padStart(13)}   ${String(count(shouldNot, 'NOT_CONFIRMED')).padStart(17)}   ${String(count(shouldNot, 'ERROR')).padStart(9)}`);
  const fc = shouldNot.filter((r) => r.got === 'CONFIRMED');
  const fnc = should.filter((r) => r.got === 'NOT_CONFIRMED');
  console.log(`\n  false-CONFIRMED rate (of cases that must not pass):   ${fc.length}/${shouldNot.length} = ${pct(fc.length, shouldNot.length)}`);
  console.log(`  false-NOT-CONFIRMED rate (of cases that should pass): ${fnc.length}/${should.length} = ${pct(fnc.length, should.length)}`);

  const show = (r) => {
    console.log(`  ${r.id} [${r.category}, ${r.window ?? ''}, split=${r.split}] ${JSON.stringify(r.prompt.length > 160 ? `${r.prompt.slice(0, 157)}...` : r.prompt)}`);
    for (const v of r.claims) console.log(`      p=${fmt(v.probability)} ${v.confirmed ? 'CONFIRMED    ' : 'not confirmed'} ${JSON.stringify(v.claim.slice(0, 90))}${v.entry ? `\n           proof: ${v.entry} (pick p=${fmt(v.entryProbability)})` : ''}${v.note ? `\n           ${v.note}` : ''}`);
  };
  console.log(`\nFALSE CONFIRMED (the dangerous error): ${fc.length}`);
  fc.forEach(show);
  console.log(`\nFALSE NOT CONFIRMED (the annoying error): ${fnc.length}`);
  fnc.forEach(show);
  const errors = results.filter((r) => r.got === 'ERROR' || r.problems.length);
  if (errors.length) {
    console.log(`\nERRORS AND OUTPUT PROBLEMS: ${errors.length}`);
    for (const r of errors) console.log(`  ${r.id}: ${r.error ?? ''} ${r.problems.join('; ')}`);
  }

  console.log('\nPER CATEGORY                 correct   false-CONFIRMED   false-NOT-CONFIRMED');
  for (const category of [...new Set(results.map((r) => r.category))]) {
    const rows = results.filter((r) => r.category === category);
    const ok = rows.filter((r) => r.got === r.expected).length;
    console.log(`  ${category.padEnd(26)} ${`${ok}/${rows.length}`.padStart(7)}   ${String(rows.filter((r) => r.expected === 'NOT_CONFIRMED' && r.got === 'CONFIRMED').length).padStart(15)}   ${String(rows.filter((r) => r.expected === 'CONFIRMED' && r.got === 'NOT_CONFIRMED').length).padStart(19)}`);
  }

  const judged = (rows) => rows.filter((r) => r.got !== 'ERROR' && r.shown);
  console.log('\nPROBABILITY OF THE LEAST LIKELY CLAIM, cases that SHOULD be confirmed (judged ones only)');
  console.log(`  ${quantiles(judged(should).map((r) => r.score))}\n${histogram(judged(should).map((r) => r.score))}`);
  console.log('\nPROBABILITY OF THE LEAST LIKELY CLAIM, cases that should NOT be confirmed (judged ones only)');
  console.log(`  ${quantiles(judged(shouldNot).map((r) => r.score))}\n${histogram(judged(shouldNot).map((r) => r.score))}`);

  // What another threshold would have done: on the probability alone, with an entry pick required, and under the
  // command's whole rule (an entry, and nothing later undoing it). Below the command's own threshold the pick is
  // only known in snapshot mode, which keeps Jev's raw answers; the whole rule is only known at 0.80 and above.
  const hasRaw = results.some((r) => r.claims.some((v) => v.rawPick !== null));
  console.log(`\nTHRESHOLD SWEEP (judged cases: ${judged(should).length} should pass, ${judged(shouldNot).length} should not). Each cell: false-CONFIRMED / false-NOT-CONFIRMED`);
  console.log('  threshold   probability alone   + an entry picked   + nothing later undoes it (the command)');
  const picked = (v) => (v.rawPick !== null ? v.rawPick !== 'NONE' : v.confirmed || /later entry|changed again/.test(v.note ?? ''));
  for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99]) {
    const alone = (r) => r.claims.length > 0 && r.claims.every((v) => (v.probability ?? 0) >= t);
    const withPick = (r) => alone(r) && r.claims.every(picked);
    const whole = (r) => alone(r) && r.claims.every((v) => v.confirmed);
    const cell = (pass) => `${String(judged(shouldNot).filter(pass).length).padStart(3)} / ${String(judged(should).filter((r) => !pass(r)).length).padEnd(3)}`;
    console.log(`  ${t.toFixed(2)}        ${cell(alone).padEnd(19)} ${(hasRaw || t >= 0.8 ? cell(withPick) : '').padEnd(19)} ${t >= 0.8 ? cell(whole) : ''}`);
  }

  // Which of the command's extra conditions changed a verdict? Claims at or over the line that were still refused.
  const reason = (v) => (/same setting changed again/.test(v.note ?? '') ? 'a later entry about the same setting (code)'
    : /later entry as undoing/.test(v.note ?? '') ? 'Jev read a later entry as undoing it'
      : /named no entry/.test(v.note ?? '') ? 'no entry was named' : 'an unreadable answer');
  const vetoed = results.flatMap((r) => r.claims.filter((v) => (v.probability ?? 0) >= 0.8 && !v.confirmed).map((v) => ({ r, v, why: reason(v) })));
  console.log(`\nREFUSED AT p >= 0.80: ${vetoed.length} claim(s)`);
  for (const why of [...new Set(vetoed.map((x) => x.why))]) {
    const rows = vetoed.filter((x) => x.why === why);
    const saved = rows.filter((x) => x.r.expected === 'NOT_CONFIRMED').length;
    console.log(`  ${why}: ${rows.length} (${saved} in cases that must not pass, ${rows.length - saved} in cases that should)`);
    for (const { r, v } of rows) console.log(`      ${r.id} (expected ${r.expected}) p=${fmt(v.probability)}${v.undone !== null && v.undone !== undefined ? ` undone=${fmt(v.undone)}` : ''} ${JSON.stringify(v.claim.slice(0, 70))}`);
  }
  const undone = (rows) => rows.flatMap((r) => r.claims.filter((v) => typeof v.undone === 'number').map((v) => v.undone));
  console.log(`\nP(A LATER ENTRY UNDID IT), claims at p >= 0.80 with an entry named\n  cases that should pass:   ${quantiles(undone(should))}\n  cases that must not pass: ${quantiles(undone(shouldNot))}`);

  const several = results.filter((r) => r.split === 'llm' || r.notes.some((n) => /^Judged as one claim/.test(n)));
  const fell = several.filter((r) => r.split !== 'llm');
  console.log(`\nLLM SPLIT: asked for ${several.length} prompts; believed ${several.length - fell.length}; fell back to the whole prompt ${fell.length} (${pct(fell.length, several.length)})`);
  for (const r of fell) console.log(`  ${r.id} (expected ${r.expected}, got ${r.got}): ${r.notes.find((n) => /^Judged as one claim/.test(n))}`);

  const groups = {};
  for (const r of results) (groups[r.repeatOf ?? (Number(args.runs) > 1 ? r.id : '')] ??= []).push(r);
  delete groups[''];
  if (Object.keys(groups).length) {
    console.log('\nIDENTICAL RUNS: how far the probability moves');
    for (const [name, rows] of Object.entries(groups)) {
      const scores = rows.map((r) => r.score);
      console.log(`  ${name.padEnd(10)} scores ${scores.map((s) => s.toFixed(3)).join(' ')}  spread ${(Math.max(...scores) - Math.min(...scores)).toFixed(3)}  verdicts ${[...new Set(rows.map((r) => r.got))].join('/')}`);
    }
  }
}

(args.mechanics ? mechanics() : runCases()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
