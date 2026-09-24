/** The record a page shows, read back for the reviewer. The Salesforce CLI and the LLM are faked; no network. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordReader, recordIds } from '../src/record.js';
import type { Page } from '../src/types.js';
import { verifyDone } from '../src/verify.js';

const page = (url: string, frames: string[] = []): Page => ({
  url, title: 't', text: '', actions: [], fingerprint: '', stats: frames.map((u, i) => ({ frame: i, url: u, open_shadow_roots: 0, closed_shadow_suspects: 0, query_selector_all: 0, walked: 0 })),
});

test('record ids are found in Lightning, Classic and Visualforce URLs, top page first', () => {
  assert.deepEqual(recordIds(page('https://x.lightning.force.com/lightning/r/loan__Loan_Product__c/a9w9j0000002AbCAAU/view')), ['a9w9j0000002AbCAAU']);
  assert.deepEqual(recordIds(page('https://x.lightning.force.com/lightning/n/Servicing', ['https://x.vf.force.com/apex/editProduct?id=a9wOm000001XyZ1&retURL=%2Fhome'])), ['a9wOm000001XyZ1']);
  assert.deepEqual(recordIds(page('https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/page?address=%2F04aOm000007bCkXIAU%2Fe')), ['04aOm000007bCkXIAU']);
  assert.deepEqual(recordIds(page('https://x.lightning.force.com/lightning/setup/FieldsAndRelationships/home')), [], 'words are not ids');
});

test('the first id with a known prefix is read, system and empty fields dropped; anything else gives null', async () => {
  const calls: string[][] = [];
  const reader = new RecordReader('my-sandbox', (_file, args, done) => {
    calls.push(args);
    // `sf api request rest` prints the REST body itself, unwrapped, as it does live.
    if (args[0] === 'api') return done(null, JSON.stringify({ sobjects: [{ keyPrefix: 'a9w', name: 'loan__Loan_Product__c', queryable: true }] }));
    done(null, JSON.stringify({ status: 0, result: { records: [{ attributes: {}, Id: 'x', Name: 'Commercial Product', loan__Max_Number_of_Installments__c: 1000, loan__Description__c: null, SystemModstamp: 'now' }] } }));
  });
  const saved = await reader.read(page('https://x/lightning/r/Foo/0019j0000000001AAA/view', ['https://x/apex/p?id=a9w9j0000002AbCAAU']));
  assert.deepEqual(saved, { object: 'loan__Loan_Product__c', id: 'a9w9j0000002AbCAAU', fields: { Name: 'Commercial Product', loan__Max_Number_of_Installments__c: 1000 } });
  assert.match(calls.find((a) => a[0] === 'data')!.join(' '), /FROM loan__Loan_Product__c WHERE Id = 'a9w9j0000002AbCAAU'/);
  await reader.read(page('https://x/lightning/r/Foo/a9w9j0000002AbCAAU/view'));
  assert.equal(calls.filter((a) => a[0] === 'api').length, 1, 'the prefix map is read once');
  assert.equal(await reader.read(page('https://x/lightning/setup/SetupOneHome/home')), null);
});

test('the reviewer is given the saved record', async () => {
  process.env.LLM_API_KEY ??= 'test';
  let sent: any;
  const verdict = await verifyDone('Max Term shows 1000', page('https://x/lightning/n/Servicing'), {
    record: { object: 'loan__Loan_Product__c', id: 'a9w', fields: { loan__Max_Number_of_Installments__c: 1000 } },
    post: async (_url, _key, body: any) => {
      sent = JSON.parse(body.messages[1].content);
      return { choices: [{ message: { content: '{"done": true, "reason": "The saved record holds 1000."}' } }], usage: {} };
    },
  });
  assert.equal(verdict.done, true);
  assert.equal(sent.saved_record.fields.loan__Max_Number_of_Installments__c, 1000);
});
