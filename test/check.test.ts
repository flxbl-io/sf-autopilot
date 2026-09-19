/** The audit command: a typed prompt, checked claim by claim against the trail. No org, no network, no paid API. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { AuditEntry, Exec } from '../src/audit.js';
import { execFile } from 'node:child_process';
import { auditCommand, judgeClaims, lastWordOnly, parseSince, splitClaims, supersededBy, UNAUDITED, UNDONE_THRESHOLD } from '../src/check.js';
import type { Post } from '../src/types.js';

const ENV = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_EXTRA_BODY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.LLM_API_KEY = 'llm-test';
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const PROMPT = 'Set deliverability to All email and change the fiscal year to April';
const CLAIMS = ['Set deliverability to All email', 'change the fiscal year to April'];
const ENTRIES: AuditEntry[] = [
  { at: '2026-09-19T04:20:01.000+0000', action: 'orgEmailDeliverability', section: 'Deliverability', display: 'Changed access to send email level from System email only to All email', by: 'Priya@Example.com' },
  { at: '2026-09-19T04:21:14.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 7 to 4', by: 'admin@example.com' },
];

/** What `sf data query` prints for these entries: newest first, as the command asks for them. */
const trail = (entries: AuditEntry[], seen: string[][] = []): Exec => (_file, args, done) => (seen.push(args), done(null, JSON.stringify({
  status: 0,
  result: { records: [...entries].reverse().map((e) => ({ CreatedDate: e.at, Action: e.action, Section: e.section, Display: e.display, CreatedBy: e.by ? { Username: e.by } : null })) },
})));

/** A well-formed choice answer over `ids`, as Jev returns it. */
const picking = (choice: string, ids: string[]) => ({
  type: 'choice', choice, confidence: 0.9,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 0.9 : 0.1 / (ids.length - 1)])),
});

/**
 * Jev is asked once per claim (see judgeClaims for why). Tests still describe its answers as claim_N,
 * claim_N_undone and claim_N_entry, N being the claim's position; this hands each request its own three.
 */
const forClaim = (answers: any, body: any) => {
  if (!answers || typeof answers !== 'object') return { answers };
  // An unsplit prompt is claim 1, and so is a lone claim, whichever of CLAIMS it happens to be.
  const at = CLAIMS.indexOf(body.state.manual_step) + 1;
  const n = at > 0 && `claim_${at}` in answers ? at : 1;
  return { answers: { confirmed: answers[`claim_${n}`], undone: answers[`claim_${n}_undone`], entry: answers[`claim_${n}_entry`] } };
};

/** One transport for both models, told apart by URL, as the command uses it. */
const models = (split: unknown, answers: unknown, seen: any[] = []): Post => async (url, key, body) => {
  seen.push({ url, key, body });
  return url.endsWith('/chat/completions') ? { choices: [{ message: { content: JSON.stringify(split) } }] } : forClaim(answers, body);
};

test('--since takes bare minutes, m, h and d, and refuses everything else by name', () => {
  assert.deepEqual(parseSince('30'), { minutes: 30, label: '30 minutes' });
  assert.deepEqual(parseSince('45m'), { minutes: 45, label: '45 minutes' });
  assert.deepEqual(parseSince('2H'), { minutes: 120, label: '2 hours' });
  assert.deepEqual(parseSince(' 1d '), { minutes: 1440, label: '1 day' });
  for (const bad of ['', 'abc', '0', '0h', '-5', '1.5h', '1w', '2 h', 'h', '181d', '30mm']) {
    assert.throws(() => parseSince(bad), new RegExp(`--since takes minutes \\(30\\).*45m, 2h, 1d.*Got "${bad}"`), bad);
  }
});

test('a prompt with nothing joining two parts is one claim, and no LLM is paid to say so', async () => {
  const split = await splitClaims('Set the default workflow user to Integration User', { post: async () => assert.fail('no call expected') });
  assert.deepEqual(split, { claims: ['Set the default workflow user to Integration User'], by: 'none', note: null });
});

test('the LLM splits a two-part prompt; a shared verb may be repeated, framing may go', async () => {
  const seen: any[] = [];
  const split = await splitClaims(PROMPT, { post: models({ claims: CLAIMS }, null, seen) });
  assert.deepEqual(split, { claims: CLAIMS, by: 'llm', note: null });
  assert.deepEqual(JSON.parse(seen[0].body.messages[1].content), { prompt: PROMPT });

  const shared = await splitClaims('Did we set deliverability to All email, and the fiscal year to April?', {
    post: models({ claims: [' set deliverability to All email ', 'Set the fiscal year to April'] }, null),
  });
  assert.deepEqual(shared.claims, ['set deliverability to All email', 'Set the fiscal year to April']);
});

test('a split that cannot be trusted falls back to the whole prompt, and says why', async () => {
  const whole = async (reply: unknown) => {
    const split = await splitClaims(PROMPT, { post: models(reply, null) });
    assert.deepEqual([split.claims, split.by], [[PROMPT], 'none']);
    return split.note!;
  };
  assert.match(await whole({ claims: 'Set deliverability' }), /did not return a list/);
  assert.match(await whole({ claims: [] }), /did not return a list/);
  assert.match(await whole({ claims: ['Set deliverability to All email', 7] }), /did not return a list/);
  assert.match(await whole({ claims: Array(9).fill('Set deliverability to All email') }), /did not return a list of 1 to 8/);
  assert.match(await whole({ steps: CLAIMS }), /did not return a list/);
  // Dropping a value would let any fiscal-year entry confirm the claim. That is the dangerous direction.
  assert.match(await whole({ claims: ['Set deliverability to All email', 'change the fiscal year'] }), /lost words from the prompt \(april\)/);
  assert.match(await whole({ claims: ['Set deliverability to All email'] }), /lost words from the prompt \(change, fiscal, year, april\)/);
  assert.match(await whole({ claims: ['Set deliverability to All email', 'change the fiscal year to October'] }), /words the prompt does not contain \(october\)/);

  const failed = await splitClaims(PROMPT, { post: async () => { throw new Error('Model connection failed; no action executed.'); } });
  assert.deepEqual([failed.claims, failed.by], [[PROMPT], 'none']);
  assert.match(failed.note!, /not split: Model connection failed/);
});

test('with no LLM key the whole prompt is one claim, and nothing is sent', async () => {
  delete process.env.LLM_API_KEY;
  const split = await splitClaims(PROMPT, { post: async () => assert.fail('no key, no call') });
  assert.deepEqual(split.claims, [PROMPT]);
  assert.match(split.note!, /not split: LLM_API_KEY is not set/);
});

test('each claim is judged ALONE, in its own Jev request, all sent together: done, undone, and which entry', async () => {
  // One request for all claims was measured live and was worse: a true claim scored 0.72-0.89 (0.78 / 0.80 on two
  // identical runs, around the cutoff), and with every claim in shared state 0.36-0.75. Alone, as `manual_step`,
  // it scored 0.86-0.97. This pins that shape.
  const seen: any[] = [];
  const { verdicts, shown } = await judgeClaims(CLAIMS, ENTRIES, {
    apiKey: 'test',
    post: models(null, {
      claim_1: { type: 'noul', noul: 0.97 }, claim_1_entry: picking('1', ['1', '2', 'NONE']), claim_1_undone: { type: 'noul', noul: 0.08 },
      claim_2: { type: 'noul', noul: 0.04 }, claim_2_entry: 'never read: the claim was not likely', claim_2_undone: 'nor this',
    }, seen),
  });
  assert.equal(seen.length, 2, 'one request per claim');
  assert.deepEqual(seen.map((r) => r.url), Array(2).fill('https://api.typesafe.ai/v1/systemone'));
  assert.deepEqual(seen.map((r) => r.body.state.manual_step), CLAIMS, 'each request holds exactly one claim');
  for (const [i, { body }] of seen.entries()) {
    assert.ok(!JSON.stringify(body).includes(CLAIMS[1 - i]), 'and no trace of the other one');
    assert.deepEqual(Object.keys(body.questions), ['confirmed', 'undone', 'entry']);
    assert.deepEqual([body.questions.confirmed.type, body.questions.undone.type, body.questions.entry.type], ['noul', 'noul', 'choice']);
    assert.match(body.questions.confirmed.instructions, /change asked for in `manual_step` was actually made, to the values it asked for\?/);
    assert.deepEqual(Object.keys(body.questions.entry.criteria), ['1', '2', 'NONE']);
    assert.match(body.questions.entry.criteria['2'], /^\[2\] orgFiscalYearStartMonth \(Company Information\): Changed fiscal year/);
    assert.deepEqual(body.state.audit_entries[1], { index: '2', action: 'orgFiscalYearStartMonth', section: 'Company Information', recorded: 'Changed fiscal year start month from 7 to 4' });
  }

  assert.equal(shown, 2);
  assert.deepEqual(verdicts[0], { claim: CLAIMS[0], probability: 0.97, confirmed: true, entry: ENTRIES[0], entryProbability: 0.9, undone: 0.08, note: null });
  assert.deepEqual(verdicts[1], { claim: CLAIMS[1], probability: 0.04, confirmed: false, entry: null, entryProbability: null, undone: null, note: null });
});

test('malformed Jev output never confirms: a likely claim with no readable proof is not confirmed', async () => {
  const judged = async (answers: unknown) => (await judgeClaims(CLAIMS, ENTRIES, { apiKey: 'test', post: models(null, answers) })).verdicts;
  const fine = { claim_1_undone: { noul: 0.05 }, claim_2: { noul: 0.9 }, claim_2_entry: picking('2', ['1', '2', 'NONE']), claim_2_undone: { noul: 0.05 } };

  const none = await judged({ ...fine, claim_1: { noul: 0.95 }, claim_1_entry: picking('NONE', ['1', '2', 'NONE']) });
  assert.deepEqual([none[0].confirmed, none[0].probability, none[0].entry], [false, 0.95, null]);
  assert.match(none[0].note!, /named no entry/);
  assert.equal(none[1].confirmed, true);

  for (const entry of [undefined, { choice: '3', confidence: 1, probabilities: { 3: 1 } }, { choice: '1', confidence: 0.9, probabilities: { 1: 0.9, 2: 0.9, NONE: 0.9 } }, picking('1', ['1', 'NONE'])]) {
    const bad = await judged({ ...fine, claim_1: { noul: 0.95 }, claim_1_entry: entry });
    assert.deepEqual([bad[0].confirmed, bad[0].entry], [false, null]);
    assert.match(bad[0].note!, /unreadable/);
  }

  for (const noul of ['high', 1.2, -0.1, NaN, null, true]) {
    const bad = await judged({ ...fine, claim_1: { noul }, claim_1_entry: picking('1', ['1', '2', 'NONE']) });
    assert.deepEqual([bad[0].confirmed, bad[0].probability, bad[0].entry], [false, null, null], String(noul));
    assert.equal(bad[1].confirmed, true);
  }
  // Just under the threshold is a no, however sure the entry pick.
  const under = await judged({ ...fine, claim_1: { noul: 0.79 }, claim_1_entry: picking('1', ['1', '2', 'NONE']) });
  assert.deepEqual([under[0].confirmed, under[0].entry], [false, null]);

  // Nothing readable at all is a failed request, not a verdict.
  for (const answers of [undefined, {}, { claim_1: {}, claim_2: { noul: '0.9' } }]) await assert.rejects(judged(answers), /Invalid TypeSafe response; the audit trail was not judged/);
  await assert.rejects(judgeClaims(CLAIMS, ENTRIES, { post: async () => assert.fail('no key, no call') }), /TYPESAFE_API_KEY is not set/);
});

test('when Jev refuses the list as too large, the entries most relevant to the claims are kept, in trail order', async () => {
  const noise: AuditEntry[] = Array.from({ length: 120 }, (_, i) => ({ at: `t${i}`, action: 'changedUserEmail', section: 'Manage Users', display: `Changed email for user ${i}`, by: null }));
  const entries = [noise[0], ENTRIES[1], ...noise.slice(1)];
  const sizes: number[] = [];
  const { verdicts, shown } = await judgeClaims([CLAIMS[1]], entries, {
    apiKey: 'test',
    post: async (_url, _key, body: any) => {
      const n = body.state.audit_entries.length;
      sizes.push(n);
      if (n > 30) throw new Error('Model provider returned HTTP 400; no action executed. {"error":"max_tokens_exceeded"}');
      const at = body.state.audit_entries.findIndex((e: any) => e.action === 'orgFiscalYearStartMonth');
      assert.equal(at, 0, 'the fiscal year entry is older than every kept noise entry');
      return { answers: { confirmed: { noul: 0.96 }, undone: { noul: 0.05 }, entry: picking('1', [...Array.from({ length: n }, (_, i) => String(i + 1)), 'NONE']) } };
    },
  });
  assert.deepEqual(sizes, [121, 80, 30]);
  assert.deepEqual([shown, verdicts[0].confirmed, verdicts[0].entry], [30, true, ENTRIES[1]]);
  // Any other failure is not retried with less.
  await assert.rejects(judgeClaims(CLAIMS, entries, { apiKey: 'test', post: async () => { throw new Error('Model provider returned HTTP 401'); } }), /HTTP 401/);
});

const run = async (flags: Parameters<typeof auditCommand>[0], deps: Parameters<typeof auditCommand>[1]) => {
  const out: string[] = [];
  const code = await auditCommand(flags, { apiKey: 'test', now: () => new Date('2026-09-19T04:30:00.000Z'), ...deps, log: (l) => out.push(l) });
  return { code, text: out.join('\n'), out };
};

test('the command reports each claim with its proof; the prompt is confirmed only if every claim is', async () => {
  const args: string[][] = [];
  const both = { claim_1: { noul: 0.97 }, claim_1_entry: picking('1', ['1', '2', 'NONE']), claim_1_undone: { noul: 0.05 }, claim_2: { noul: 0.96 }, claim_2_entry: picking('2', ['1', '2', 'NONE']), claim_2_undone: { noul: 0.05 } };
  const yes = await run({ org: 'my-org', step: PROMPT, since: '2h' }, { exec: trail(ENTRIES, args), post: models({ claims: CLAIMS }, both) });
  assert.equal(yes.code, 0);
  assert.match(args[0][args[0].indexOf('--query') + 1], /CreatedDate >= 2026-09-19T02:29:00Z ORDER BY CreatedDate DESC/);
  assert.match(yes.out[0], /^Setup Audit Trail of my-org, last 2 hours: 2 entries\n {2}04:20:01 {2}orgEmailDeliverability/);
  assert.match(yes.text, /CONFIRMED {6}p=0\.97 {2}Set deliverability to All email\n {4}recorded: 04:20:01 {2}orgEmailDeliverability .*\(Priya@Example\.com\)/);
  assert.match(yes.text, /CONFIRMED {6}p=0\.96 {2}change the fiscal year to April\n {4}recorded: 04:21:14 {2}orgFiscalYearStartMonth/);
  assert.match(yes.text, /\nCONFIRMED: 2 of 2 claims$/);

  const half = await run({ org: 'my-org', step: PROMPT }, { exec: trail(ENTRIES), post: models({ claims: CLAIMS }, { ...both, claim_2: { noul: 0.04 } }) });
  assert.equal(half.code, 2);
  assert.match(half.text, /NOT CONFIRMED {2}p=0\.04 {2}change the fiscal year to April/);
  assert.match(half.text, /\nNOT CONFIRMED: 1 of 2 claims$/);
});

test('--no-split and a missing LLM key judge the prompt whole; a day-long window prints dates', async () => {
  const one = { claim_1: { noul: 0.9 }, claim_1_entry: picking('2', ['1', '2', 'NONE']), claim_1_undone: { noul: 0.05 } };
  const seen: any[] = [];
  const whole = await run({ org: 'my-org', step: PROMPT, noSplit: true, since: '1d' }, { exec: trail(ENTRIES), post: models(null, one, seen) });
  assert.deepEqual(seen.map((s) => s.url), ['https://api.typesafe.ai/v1/systemone']);
  assert.equal(seen[0].body.state.manual_step, PROMPT);
  assert.match(whole.text, /recorded: 2026-09-19 04:21:14 {2}orgFiscalYearStartMonth/);
  assert.match(whole.text, /\nCONFIRMED: 1 of 1 claim$/);

  delete process.env.LLM_API_KEY;
  const keyless = await run({ org: 'my-org', step: PROMPT }, { exec: trail(ENTRIES), post: models(null, one) });
  assert.equal(keyless.code, 0);
  assert.match(keyless.text, /Judged as one claim; the prompt was not split: LLM_API_KEY is not set/);
});

test('--by keeps only that user’s changes, whatever the case, and says who else was there when none match', async () => {
  const seen: any[] = [];
  const hers = await run({ org: 'my-org', step: CLAIMS[0], by: 'priya@example.com' }, {
    exec: trail(ENTRIES), post: models(null, { claim_1: { noul: 0.97 }, claim_1_entry: picking('1', ['1', 'NONE']), claim_1_undone: { noul: 0.05 } }, seen),
  });
  assert.equal(hers.code, 0);
  assert.match(hers.out[0], /last 30 minutes, by priya@example\.com: 1 entry\n/);
  assert.deepEqual(seen[0].body.state.audit_entries.map((e: any) => e.action), ['orgEmailDeliverability']);

  const nobody = await run({ org: 'my-org', step: CLAIMS[0], by: 'sam@example.com' }, { exec: trail(ENTRIES), post: async () => assert.fail('nothing to judge') });
  assert.equal(nobody.code, 2);
  assert.match(nobody.text, /No entry in the last 30 minutes was made by sam@example\.com\. The 2 recorded there were made by: Priya@Example\.com, admin@example\.com\./);
  assert.match(nobody.text, /\nNOT CONFIRMED: Set deliverability to All email$/);
});

test('an empty window is said plainly, with what Salesforce is known not to audit, and no model is asked', async () => {
  const empty = await run({ org: 'my-org', step: PROMPT, since: '45m' }, { exec: trail([]), post: async () => assert.fail('nothing to judge') });
  assert.equal(empty.code, 2);
  assert.match(empty.out[0], /last 45 minutes: 0 entries$/);
  assert.match(empty.text, /Salesforce recorded no Setup change in the last 45 minutes\. If the change is older, widen --since/);
  assert.match(empty.text, /Nothing was judged\. Salesforce does not audit every Setup action/);
  for (const action of UNAUDITED) assert.ok(empty.text.includes(action), action);
  assert.equal(UNAUDITED.length, 4);
});

test('--json prints one object and nothing else, with the same exit codes', async () => {
  const answers = { claim_1: { noul: 0.97 }, claim_1_entry: picking('1', ['1', '2', 'NONE']), claim_1_undone: { noul: 0.05 }, claim_2: { noul: 0.3 }, claim_2_entry: picking('NONE', ['1', '2', 'NONE']), claim_2_undone: { noul: 0.05 } };
  const no = await run({ org: 'my-org', step: PROMPT, json: true, since: '2h' }, { exec: trail(ENTRIES), post: models({ claims: CLAIMS }, answers) });
  assert.equal(no.code, 2);
  assert.equal(no.out.length, 1);
  const report = JSON.parse(no.out[0]);
  assert.deepEqual(
    [report.org, report.prompt, report.confirmed, report.threshold, report.split, report.since, report.minutes, report.window, report.by, report.shown],
    ['my-org', PROMPT, false, 0.8, 'llm', '2026-09-19T02:30:00.000Z', 120, '2 hours', null, 2],
  );
  assert.deepEqual(report.claims.map((c: any) => [c.claim, c.probability, c.confirmed, c.entry?.action ?? null]), [[CLAIMS[0], 0.97, true, 'orgEmailDeliverability'], [CLAIMS[1], 0.3, false, null]]);
  assert.deepEqual(report.entries, ENTRIES);

  const yes = await run({ org: 'my-org', step: CLAIMS[0], json: true }, { exec: trail(ENTRIES), post: models(null, answers) });
  assert.deepEqual([yes.code, JSON.parse(yes.out[0]).confirmed, yes.out.length], [0, true, 1]);

  const empty = await run({ org: 'my-org', step: PROMPT, json: true }, { exec: trail([]), post: async () => assert.fail('nothing to judge') });
  const nothing = JSON.parse(empty.out[0]);
  assert.deepEqual([empty.code, empty.out.length, nothing.confirmed, nothing.claims[0].probability, nothing.entries], [2, 1, false, null, []]);
  assert.match(nothing.notes.join(' '), /does not audit every Setup action/);
});

test('an error exits 1: thrown for the CLI to print, or as the one JSON object under --json', async () => {
  const denied: Exec = (_f, _a, done) => done(null, JSON.stringify({ status: 1, message: 'No authorization information found' }));
  await assert.rejects(run({ org: 'my-org', step: PROMPT }, { exec: denied }), /Could not read the Setup Audit Trail of my-org/);
  await assert.rejects(run({ org: 'my-org', step: PROMPT, since: 'yesterday' }, { exec: trail(ENTRIES) }), /--since takes minutes/);
  await assert.rejects(run({ step: PROMPT }, {}), /Supply --org/);
  await assert.rejects(run({ org: 'my-org', step: '  ' }, {}), /what should have happened/);
  await assert.rejects(run({ org: 'my-org', step: PROMPT, noSplit: true }, { exec: trail(ENTRIES), post: models(null, { claim_1: { noul: 'yes' } }) }), /Invalid TypeSafe response/);

  const failed = await run({ org: 'my-org', step: PROMPT, json: true }, { exec: denied });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.out.map((l) => JSON.parse(l)), [{ confirmed: false, error: 'Could not read the Setup Audit Trail of my-org: No authorization information found' }]);

  // No Jev key: said before the LLM is paid to split.
  const keyless = await run({ org: 'my-org', step: PROMPT, json: true }, { apiKey: undefined, exec: trail(ENTRIES), post: async () => assert.fail('no key, no call') });
  assert.deepEqual([keyless.code, JSON.parse(keyless.out[0]).error], [1, 'TYPESAFE_API_KEY is not set']);
});

test('a window that fills the 200-entry read is flagged, and it is the OLDEST changes that were cut off', async () => {
  // Seen live on a sandbox with 2,017 entries: asked oldest first, --since 180d read 28 July to 4 August and a
  // change made that morning was NOT CONFIRMED. The newest 200 are the ones a release step is in.
  const many: AuditEntry[] = Array.from({ length: 200 }, (_, i) => ({ ...ENTRIES[1], display: `Created custom field: Field ${i} (Text)`, action: 'createdCF', at: `2026-09-19T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}:00.000+0000` }));
  const args: string[][] = [];
  const full = await run({ org: 'my-org', step: CLAIMS[1], json: true, since: '1d' }, {
    exec: trail(many, args), post: models(null, { claim_1: { noul: 0.9 }, claim_1_undone: { noul: 0.05 }, claim_1_entry: picking('200', [...many.map((_, i) => String(i + 1)), 'NONE']) }),
  });
  assert.match(args[0][args[0].indexOf('--query') + 1], /ORDER BY CreatedDate DESC, Id DESC LIMIT 200$/);
  const report = JSON.parse(full.out[0]);
  assert.match(report.notes[0], /Only the newest 200 entries of the window were read \(from 2026-09-19 00:00:00\), so its older changes are missing/);
  assert.deepEqual([report.entries[0].at, report.entries.at(-1).at, report.claims[0].entry.at], [many[0].at, many[199].at, many[199].at]);
});

// ---- Regressions from the live evaluation (docs/audit-command-evaluation.md). Each fails without its fix. ----

const FISCAL: AuditEntry[] = [
  { at: '2026-09-19T04:09:53.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Profile', display: 'Changed fiscal year start month from 1 to 7', by: 'admin@example.com' },
  { at: '2026-09-19T04:13:13.000+0000', action: 'oweaCreated', section: 'Email Administration', display: 'Added autopilot-trial@example.com with Purpose User Selection in Organization-Wide Addresses', by: 'admin@example.com' },
  { at: '2026-09-19T04:21:14.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Profile', display: 'Changed fiscal year start month from 7 to 4', by: 'admin@example.com' },
];

test('a change the trail shows replaced later is NOT confirmed, however sure Jev is that it was made', async () => {
  // Seen live: "Set the fiscal year start month to July" CONFIRMED at p=0.96, proof "from 1 to 7", with "from 7 to 4"
  // twelve minutes later in the same list. Here Jev is just as sure, and even says nothing undid it.
  const judged = async (claim: string, pick: string, undone: unknown = { noul: 0.02 }, entries = FISCAL) =>
    (await judgeClaims([claim], entries, { apiKey: 'test', post: models(null, { claim_1: { noul: 0.96 }, claim_1_entry: picking(pick, [...entries.map((_, i) => String(i + 1)), 'NONE']), claim_1_undone: undone }) })).verdicts[0];

  // The code check itself: the proof's setting has a different last entry, so it was changed again.
  assert.equal(supersededBy(FISCAL, 0)?.display, FISCAL[2].display);
  assert.equal(supersededBy(FISCAL, 2), null);
  // Since then Jev is not even offered "from 1 to 7": only the setting's last entry is put in front of it (see
  // lastWordOnly), so July has nothing to be proved by, and April is proved by the one entry that stands.
  const offered: string[][] = [];
  const standing = lastWordOnly(FISCAL);
  assert.ok(!standing.some((e) => e.display === FISCAL[0].display) && standing.some((e) => e.display === FISCAL[2].display));
  const last = String(standing.findIndex((e) => e.display === FISCAL[2].display) + 1);
  const ids = [...standing.map((_, i) => String(i + 1)), 'NONE'];
  const ask = async (claim: string, noul: number, pick: string, undone: unknown = { noul: 0.02 }) => (await judgeClaims([claim], FISCAL, { apiKey: 'test',
    post: async (_u, _k, body: any) => (offered.push(body.state.audit_entries.map((e: any) => e.recorded)), { answers: { confirmed: { noul }, undone, entry: picking(pick, ids) } }) })).verdicts[0];
  const july = await ask('Set the fiscal year start month to July', 0.96, 'NONE');
  assert.deepEqual([july.confirmed, july.entry], [false, null], 'however sure Jev is, there is no entry left to prove July');
  assert.ok(!offered[0].includes(FISCAL[0].display), 'the superseded entry was never shown');
  const april = await ask('Set the fiscal year start month to April', 0.96, last);
  assert.deepEqual([april.confirmed, april.entry], [true, FISCAL[2]]);

  // Jev's own reading of a later entry refuses too, where no wording ties the two entries together.
  const created: AuditEntry[] = [
    { at: '2026-09-19T04:35:57.000+0000', action: 'createdCF', section: 'Customize Accounts', display: 'Created custom field: Autopilot Trial Field (Text)', by: null },
    { at: '2026-09-19T04:36:05.000+0000', action: 'deletedCF', section: 'Customize Accounts', display: 'Deleted custom field Autopilot Trial Field', by: null },
  ];
  const field = await judged('Create a custom field Autopilot Trial Field', '1', { noul: 0.87 }, created);
  assert.deepEqual([field.confirmed, field.entry, field.undone], [false, null, 0.87]);
  assert.match(field.note!, /Jev reads a later entry as undoing it \(p=0\.87\)/);
  const atLine = await judged('Create a custom field Autopilot Trial Field', '1', { noul: UNDONE_THRESHOLD }, created);
  assert.equal(atLine.confirmed, false);
  const under = await judged('Create a custom field Autopilot Trial Field', '1', { noul: UNDONE_THRESHOLD - 0.01 }, created);
  assert.equal(under.confirmed, true);

  // Malformed output never confirms: no readable answer on "was it undone?" is a no.
  for (const undone of [null, {}, { noul: 'low' }, { noul: 1.4 }, { noul: -0.1 }, { noul: NaN }, 'no']) {
    const bad = await ask('Set the fiscal year start month to April', 0.96, last, undone);
    assert.deepEqual([bad.confirmed, bad.entry], [false, null], JSON.stringify(undone));
    assert.match(bad.note!, /whether a later entry undid the change was unreadable/);
  }
});

test('the last entry about a setting decides: toggled back and forth, only where it ended can be confirmed', () => {
  // Seen live: "Allow users to relate a contact to multiple accounts" went on and off five times and ended off,
  // and "was enabled" was CONFIRMED at 0.94.
  const flip = (at: string, to: 'on' | 'off'): AuditEntry[] => [
    { at, action: to === 'on' ? 'sharedContactsOffOn' : 'sharedContactsOnOff', section: 'Sharing Defaults', display: `Changed Allow users to relate a contact to multiple accounts from ${to === 'on' ? 'off to on' : 'on to off'}`, by: null },
    { at, action: to === 'on' ? 'SharedContactsReadyOffOn' : 'SharedContactsReadyOnOff', section: 'Sharing Defaults', display: `Contacts to Multiple Accounts ${to === 'on' ? 'Enabled' : 'Disabled'}`, by: null },
  ];
  const toggled = [...flip('t1', 'on'), ...flip('t2', 'off'), ...flip('t3', 'on'), ...flip('t4', 'off')];
  assert.equal(supersededBy(toggled, 4)?.display, 'Changed Allow users to relate a contact to multiple accounts from on to off');
  assert.equal(supersededBy(toggled, 5)?.display, 'Contacts to Multiple Accounts Disabled');
  // Picking an earlier "off" is not held against the claim: the last word is the same.
  assert.equal(supersededBy(toggled, 2), null);
  assert.equal(supersededBy(toggled, 6), null);
  assert.equal(supersededBy(toggled, 7), null);
  // Another item under the same wording is another setting; an entry with no such wording is left to Jev.
  const users: AuditEntry[] = [
    { at: 't1', action: 'changedUserEmail', section: 'Manage Users', display: 'Changed email for user A from a@example.com to b@example.com', by: null },
    { at: 't2', action: 'changedUserEmail', section: 'Manage Users', display: 'Changed email for user B from c@example.com to d@example.com', by: null },
    { at: 't3', action: 'insertCertificate', section: null, display: 'Created Certificate Autopilot Trial Cert', by: null },
  ];
  assert.deepEqual([supersededBy(users, 0), supersededBy(users, 2)], [null, null]);
});

test('an audit action code is not a claim: it is refused without asking Jev', async () => {
  // Seen live: the prompt "changedDefaultWorkflowUser" CONFIRMED at p=0.96, and "orgFiscalYearStartMonth" at 0.80 on
  // one run and 0.78 on the next. A code says a setting was touched, not to what.
  const code = await run({ org: 'my-org', step: 'orgFiscalYearStartMonth', since: '2h' }, { exec: trail(ENTRIES), post: async () => assert.fail('nothing worded to judge') });
  assert.equal(code.code, 2);
  assert.match(code.text, /NOT CONFIRMED {2}p=\? {5}orgFiscalYearStartMonth\n {4}A single word names no change; it reads like an audit action code/);
  assert.match(code.text, /\nNOT CONFIRMED: 0 of 1 claim$/);

  // Beside a worded claim, only the worded claim reaches Jev, and the prompt is still not confirmed.
  const seen: any[] = [];
  const mixed = await run({ org: 'my-org', step: 'Set deliverability to All email and orgFiscalYearStartMonth', json: true }, {
    exec: trail(ENTRIES),
    post: models({ claims: ['Set deliverability to All email', 'orgFiscalYearStartMonth'] }, { claim_1: { noul: 0.97 }, claim_1_entry: picking('1', ['1', '2', 'NONE']), claim_1_undone: { noul: 0.05 } }, seen),
  });
  const report = JSON.parse(mixed.out[0]);
  assert.deepEqual(Object.keys(seen[1].body.questions), ['confirmed', 'undone', 'entry']);
  assert.equal(seen.length, 2, 'the bare action code was refused without a Jev request: one split call, one claim judged');
  assert.deepEqual([mixed.code, report.confirmed, report.claims.map((c: any) => c.confirmed)], [2, false, [true, false]]);
  // A sentence in a script without spaces is not a code.
  assert.equal((await run({ org: 'my-org', step: 'デフォルトのワークフローユーザーを変更した', json: true }, { exec: trail(ENTRIES), post: models(null, { claim_1: { noul: 0.1 } }) })).code, 2);
});

test('--by given but empty is an error, not a filter quietly dropped', async () => {
  // Seen live: --by "" exited 0, CONFIRMED on a change made by whoever.
  for (const by of ['', '   ']) {
    const empty = await run({ org: 'my-org', step: CLAIMS[0], by, json: true }, { exec: async () => assert.fail('no query'), post: async () => assert.fail('no call') });
    assert.deepEqual([empty.code, JSON.parse(empty.out[0])], [1, { confirmed: false, error: '--by was given but is empty. Name the user, or leave --by out to accept a change by anyone.' }]);
  }
});

test('a numbered list is split, and a split may add "set", "to" or "was" but never a negation or a direction', async () => {
  // Seen live: "1) deliverability = All email 2) fiscal year starts April ..." has no "and" and no comma, so four
  // claims were judged as one without a word; and 4 of 36 splits were thrown away for adding only "was" or "to".
  const list = 'Checklist 1) deliverability All email 2) fiscal year April';
  let asked = 0;
  const numbered = await splitClaims(list, { post: async () => (asked++, { choices: [{ message: { content: JSON.stringify({ claims: ['Checklist 1) deliverability All email', '2) fiscal year April'] }) } }] }) });
  assert.deepEqual([asked, numbered.by, numbered.claims.length], [1, 'llm', 2]);

  const glued = await splitClaims('Time zone Brisbane. Workflow user Integration User.', { post: models({ claims: ['Set time zone to Brisbane', 'Workflow user was set to Integration User'] }, null) });
  assert.deepEqual([glued.by, glued.note], ['llm', null]);
  for (const [claims, word] of [[['Time zone not Brisbane', 'Workflow user Integration User'], 'not'], [['Time zone Brisbane off', 'Workflow user Integration User'], 'off'], [['Time zone Brisbane', 'No workflow user Integration User'], 'no']] as const) {
    const refused = await splitClaims('Time zone Brisbane. Workflow user Integration User.', { post: models({ claims }, null) });
    assert.deepEqual([refused.by, refused.claims.length], ['none', 1]);
    assert.match(refused.note!, new RegExp(`words the prompt does not contain \\(${word}\\)`));
  }
});

test('under --json the CLI prints one JSON object even when the arguments cannot be parsed', async () => {
  // Seen live: `audit --json --bogus`, `--since` with no value and `--step "- a bulleted list"` printed nothing on
  // stdout. No org, no network: parseArgs fails before anything is read.
  const cli = (argv: string[]) => new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = execFile(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, ...argv], { env: { PATH: process.env.PATH } }, (_error, stdout) => resolve({ code: child.exitCode, stdout }));
  });
  for (const argv of [['audit', '--org', 'my-org', '--json', '--bogus'], ['audit', '--org', 'my-org', '--json', '--since'], ['audit', '-o', 'my-org', '--json', '--step', '- expire all passwords']]) {
    const { code, stdout } = await cli(argv);
    const printed = JSON.parse(stdout);
    assert.deepEqual([code, printed.confirmed, typeof printed.error, Object.keys(printed)], [1, false, 'string', ['confirmed', 'error']], argv.join(' '));
  }
  assert.match(JSON.parse((await cli(['audit', '-o', 'my-org', '--json', '--step', '- expire all passwords'])).stdout).error, /--step=/);
});

test('a setting changed several times is shown to Jev by its last entry only; the full trail is still reported', async () => {
  // Seen live: a reset ("to All email") then the real change ("to System email only") in one window. A true claim
  // scored 0.68-0.80 on that pair and was refused; on the last entry alone it scores 0.96.
  const at = (time: string, display: string, action = 'sendEmailAccessControl'): AuditEntry => ({ at: `2026-09-19T${time}.000+0000`, action, section: null, display, by: 'a@example.com' });
  const reset = at('06:31:30', 'Changed Access to Send Email level from System email only to All email');
  const change = at('06:33:28', 'Changed Access to Send Email level from All email to System email only');
  const field = at('06:32:00', 'Created custom field: Tag (Text)', 'createdCF');
  assert.deepEqual(lastWordOnly([reset, field, change]), [field, change], 'the superseded reset is dropped; an entry that names no setting stays');
  assert.deepEqual(lastWordOnly([change, reset]), [reset], 'whichever came last stands, even if it undoes the claim');

  const seen: any[] = [];
  const report = await run({ org: 'my-org', step: 'Email deliverability was set to System email only', json: true, noSplit: true }, {
    exec: trail([reset, change]),
    post: models(null, { claim_1: { noul: 0.96 }, claim_1_undone: { noul: 0.08 }, claim_1_entry: picking('1', ['1', 'NONE']) }, seen),
  });
  assert.deepEqual(seen[0].body.state.audit_entries.map((e: any) => e.recorded), [change.display], 'Jev saw only what holds now');
  const out = JSON.parse(report.out[0]);
  assert.deepEqual([report.code, out.confirmed, out.entries.length], [0, true, 2], 'the person still sees both entries');
  assert.match(out.notes.join(' '), /1 earlier change\(s\) to a setting that was changed again were left out/);
});
