/** Reading Salesforce's Setup Audit Trail. No org, no network: the CLI call is injected. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_THRESHOLD, audited, confirmFromAudit, setupAuditTrail, type Exec } from '../src/audit.js';

const replying = (payload: unknown, seen: string[][] = []): Exec => (_file, args, done) => (seen.push(args), done(null, JSON.stringify(payload)));

test('entries since the run began are read with a minute of slack, and handed back oldest first', async () => {
  const seen: string[][] = [];
  const record = (at: string, display: string) => ({ CreatedDate: at, Action: 'orgFiscalYearStartMonth', Section: 'Company Information', Display: display, CreatedBy: { Username: 'admin@example.com' } });
  // Salesforce is asked for the newest first, so that a full read drops the oldest entries and never the newest.
  const entries = await setupAuditTrail('my-org', new Date('2026-09-19T04:21:00.500Z'), replying({
    status: 0,
    result: { records: [record('2026-09-19T04:21:14.000+0000', 'Changed fiscal year start month from 7 to 4'), record('2026-09-19T04:20:53.000+0000', 'Changed fiscal year start month from 1 to 7')] },
  }, seen));
  assert.deepEqual(entries, [
    { at: '2026-09-19T04:20:53.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 1 to 7', by: 'admin@example.com' },
    { at: '2026-09-19T04:21:14.000+0000', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 7 to 4', by: 'admin@example.com' },
  ]);
  const soql = seen[0][seen[0].indexOf('--query') + 1];
  assert.match(soql, /FROM SetupAuditTrail WHERE CreatedDate >= 2026-09-19T04:20:00Z ORDER BY CreatedDate DESC, Id DESC LIMIT 200$/);
  assert.deepEqual(seen[0].slice(0, 4), ['data', 'query', '--target-org', 'my-org']);
});

test('the expected action is matched by code, not by wording', () => {
  const entries = [{ at: 't', action: 'recalcSharingRuleStart', section: null, display: 'Initiated sharing rule recalculation: Lead', by: null }];
  assert.equal(audited(entries, 'RecalcSharingRuleStart')?.display, 'Initiated sharing rule recalculation: Lead');
  assert.equal(audited(entries, 'orgFiscalYearStartMonth'), undefined);
});

test('a failed query says so instead of looking like an empty trail', async () => {
  await assert.rejects(setupAuditTrail('my-org', new Date(), replying({ status: 1, message: 'No authorization information found' })),
    /Could not read the Setup Audit Trail of my-org: No authorization information found/);
  await assert.rejects(setupAuditTrail('my-org', new Date(), (_f, _a, done) => done(new Error('ENOENT'), '')), /Could not read the Setup Audit Trail/);
});

test('Jev judges the audit trail with one yes/no question, and nothing is asked when there is nothing to judge', async () => {
  const entries = [{ at: 't', action: 'orgFiscalYearStartMonth', section: 'Company Information', display: 'Changed fiscal year start month from 7 to 4', by: null }];
  const seen: any[] = [];
  const yes = await confirmFromAudit('Set the fiscal year to start in April.', entries, {
    apiKey: 'test', post: async (url, _key, body) => (seen.push({ url, body }), { answers: { confirmed: { type: 'noul', noul: 0.97 } } }),
  });
  assert.deepEqual([yes.confirmed, yes.probability], [true, 0.97]);
  assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen[0].body.questions.confirmed.type, 'noul');
  assert.deepEqual(seen[0].body.state.audit_entries, [{ action: 'orgFiscalYearStartMonth', section: 'Company Information', recorded: 'Changed fiscal year start month from 7 to 4' }]);

  const no = await confirmFromAudit('x', entries, { apiKey: 'test', post: async () => ({ answers: { confirmed: { noul: AUDIT_THRESHOLD - 0.01 } } }) });
  assert.equal(no.confirmed, false);
  const empty = await confirmFromAudit('x', [], { apiKey: 'test', post: async () => assert.fail('nothing to judge') });
  assert.deepEqual([empty.confirmed, empty.probability], [false, 0]);
  await assert.rejects(confirmFromAudit('x', entries, { apiKey: 'test', post: async () => ({ answers: { confirmed: { noul: 'high' } } }) }), /Invalid TypeSafe/);
});
