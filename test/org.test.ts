/** What the planner is told the org has. The Salesforce CLI is faked; nothing leaves the machine. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orgContext } from '../src/org.js';

test("the org's apps, custom tabs and packages are read as sorted, unique labels", async () => {
  const calls: string[][] = [];
  const context = await orgContext('my-sandbox', (_file, args, done) => {
    calls.push(args);
    const soql = args[args.indexOf('--query') + 1];
    const records = soql.includes('AppMenuItem') ? [{ Label: 'Q2 Origination' }, { Label: 'Conga Composer' }, { Label: 'Q2 Origination' }]
      : soql.includes('TabDefinition') ? [{ Label: 'Rules' }, { Label: 'Points Setups' }, { Label: '' }]
      : [{ SubscriberPackage: { Name: 'Origination' } }, { SubscriberPackage: null }];
    done(null, JSON.stringify({ status: 0, result: { records } }));
  });
  assert.deepEqual(context, { apps: ['Conga Composer', 'Q2 Origination'], tabs: ['Points Setups', 'Rules'], packages: ['Origination'] });
  assert.ok(calls.every((a) => a.includes('--target-org') && a.includes('my-sandbox')));
  assert.ok(calls.find((a) => a.join(' ').includes('InstalledSubscriberPackage'))!.includes('--use-tooling-api'));
});

test('a query that fails leaves its list empty instead of failing the plan', async () => {
  const context = await orgContext('gone', (_file, _args, done) => done(new Error('sf exited 1'), '{"status":1,"message":"No such org"}'));
  assert.deepEqual(context, { apps: [], tabs: [], packages: [] });
});
