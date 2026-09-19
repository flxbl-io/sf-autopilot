/**
 * Loop policy, with a stub browser: reviewing DONE, and stopping at a destructive warning. No browser, no network.
 *
 * Both behaviours exist because of one live run: Jev declared DONE (p=0.87) while Salesforce's "this permanently
 * deletes data" confirmation was still open, and the org's metadata showed the setting unchanged.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaywrightBrowser } from '../src/browser.js';
import { run } from '../src/run.js';
import { verifyDone } from '../src/verify.js';
import type { Decision, Page, Post } from '../src/types.js';

const page = (text: string, n = 0): Page => ({
  url: 'https://x.my.salesforce-setup.com/lightning/setup/AccountSettings/home',
  title: 'Account Settings',
  text,
  fingerprint: `f${n}`,
  stats: [],
  actions: [
    { id: 'e1', kind: 'click', label: 'Save (in frame: Account Settings)', role: 'button', node: '1:1' },
    { id: 'e2', kind: 'click', label: 'Yes, I understand (in frame: Account Settings)', role: 'checkbox', checked: 'false', node: '1:2' },
    { id: 'wait', kind: 'wait', label: 'Wait' },
  ],
});

function stub(text: string) {
  const acted: string[] = [];
  let n = 0;
  const browser = {
    observe: async () => page(text, n++),
    act: async (action: { id: string }) => (acted.push(action.id), 'click'),
    screenshot: async () => undefined,
  } as unknown as PlaywrightBrowser;
  return { browser, acted };
}

const decide = (choice: string): Decision => ({
  choice, operation: choice === 'DONE' ? 'DONE' : 'CLICK', target: null, confidence: 0.9,
  probabilities: { [choice]: 0.9 }, operationProbabilities: {}, targetConfidence: null, model: 't', usage: {}, latencyMs: 1,
});

test('a rejected DONE goes back to Jev as a note, and a confirmed DONE is marked verified', async () => {
  const { browser, acted } = stub('Account Settings');
  const goals: string[] = [];
  const script = ['DONE', 'e2'];
  const verdicts = [{ done: false, reason: 'A confirmation dialog is open.' }, { done: true, reason: 'Saved.' }];
  const result = await run(browser, 'Turn it off', {
    choose: async (_page, goal) => (goals.push(goal), decide(script.shift()!)),
    verify: async () => verdicts.shift()!,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.verified, true);
  assert.deepEqual(acted, ['e2'], 'Jev carried on after the rejection');
  assert.equal(result.jevRequests, 2, 'the reviewer ended the run after the fix; Jev was not asked to claim DONE again');
  assert.doesNotMatch(goals[0], /reviewer/i);
  assert.match(goals[1], /reviewer looked at the page after DONE was claimed and said: A confirmation dialog is open\./);
  assert.equal(result.steps[0].verdict?.done, false);
});

test('two rejected DONEs end the run as unverified, never as done', async () => {
  const { browser } = stub('Account Settings');
  const result = await run(browser, 'Turn it off', {
    choose: async () => decide('DONE'),
    verify: async () => ({ done: false, reason: 'Still in edit mode.' }),
  });
  assert.equal(result.status, 'unverified: Still in edit mode.');
  assert.equal(result.verified, false);
  assert.equal(result.jevRequests, 2);
});

test('without a reviewer, DONE is accepted but never marked verified', async () => {
  const { browser } = stub('Account Settings');
  const result = await run(browser, 'x', { choose: async () => decide('DONE') });
  assert.deepEqual([result.status, result.verified], ['done', false]);
});

test('a page that warns of permanent data loss stops the run before any input', async () => {
  const warning = 'If you disable Contacts to Multiple Accounts, all contact relationship data will be permanently deleted.';
  const blocked = stub(warning);
  const stopped = await run(blocked.browser, 'Turn it off', { choose: async () => decide('e2') });
  assert.match(stopped.status, /^stopped: the page warns of permanent data loss/);
  assert.deepEqual(blocked.acted, []);

  const allowed = stub(warning);
  const script = ['e2', 'DONE'];
  const went = await run(allowed.browser, 'Turn it off', { allowDestructive: true, choose: async () => decide(script.shift()!) });
  assert.equal(went.status, 'done');
  assert.deepEqual(allowed.acted, ['e2']);
});

test('the reviewer sees the done-condition, page text and control state; an unreadable verdict is a no', async () => {
  process.env.LLM_API_KEY = 'test';
  const seen: any[] = [];
  const reply = (content: string): Post => async (_u, _k, body: any) => (seen.push(body), { choices: [{ message: { content } }] });
  const verdict = await verifyDone('The checkbox is unchecked after saving.', page('Disable Contacts to Multiple Accounts'), {
    post: reply('{"done":false,"reason":"A confirmation dialog is open."}'),
  });
  assert.deepEqual(verdict, { done: false, reason: 'A confirmation dialog is open.' });
  const sent = JSON.parse(seen[0].messages[1].content);
  assert.equal(sent.done_when, 'The checkbox is unchecked after saving.');
  assert.match(sent.page.text, /Disable Contacts/);
  assert.equal(sent.controls.find((c: any) => c.role === 'checkbox').checked, 'false');

  for (const content of ['{"done":"yes","reason":"x"}', '{"reason":"x"}']) {
    const bad = await verifyDone('x', page('y'), { post: reply(content) });
    assert.equal(bad.done, false, content);
  }
});

test('in the endgame the note to Jev tracks the reviewer, so a fixed problem is not reported as open', async () => {
  const { browser } = stub('Account Settings');
  const goals: string[] = [];
  const script = ['DONE', 'e2', 'e1', 'DONE'];
  const verdicts = [
    { done: false, reason: 'A confirmation dialog is open.' },
    { done: false, reason: 'The form is still in edit mode.' },
    { done: true, reason: 'Saved.' },
  ];
  const result = await run(browser, 'Turn it off', {
    choose: async (_page, goal) => (goals.push(goal), decide(script.shift()!)),
    verify: async () => verdicts.shift()!,
  });
  assert.deepEqual([result.status, result.verified, result.actions], ['done', true, 2]);
  assert.match(goals[2], /still in edit mode/);
  assert.doesNotMatch(goals[2], /confirmation dialog/, 'the resolved problem is gone from the note');
  assert.match(goals[2], /If it has since been resolved, DONE is correct\./);
});

test('one BLOCKED means look again after a pause; only two in a row end the run', async () => {
  const first = stub('Account Settings');
  const script = ['BLOCKED', 'e2', 'DONE'];
  const recovered = await run(first.browser, 'x', { choose: async () => decide(script.shift()!) });
  assert.equal(recovered.status, 'done');
  assert.deepEqual(first.acted, ['wait', 'wait', 'e2'], 'it paused, looked again, and carried on');

  const second = stub('Account Settings');
  const stuck = await run(second.browser, 'x', { choose: async () => decide('BLOCKED') });
  assert.equal(stuck.status, 'blocked');
  assert.equal(stuck.jevRequests, 2);
});

test('the reviewer ends the run after the click that finishes the step, before Jev can overshoot', async () => {
  // Seen live: Jev released the right component, never said DONE, and went on to release a second one.
  const { browser, acted } = stub('Package Details');
  const verdicts = [{ done: false, reason: 'The component is still listed.' }, { done: true, reason: 'Tag is no longer listed.' }];
  const result = await run(browser, 'Remove Tag from the package', {
    choose: async () => decide('e1'), // Jev would click forever
    verify: async () => verdicts.shift()!,
  });
  assert.deepEqual([result.status, result.verified], ['done', true]);
  assert.deepEqual(acted, ['e1', 'e1'], 'stopped at the click that completed the step');
});

test('a text helper with no value is a missed action, not a crashed run; the reviewer is told what just happened', async () => {
  const { browser, acted } = stub('Account Settings');
  const filled = { ...page('x'), actions: [{ id: 'f1', kind: 'fill' as const, label: 'Default Workflow User', node: '1:9' }, ...page('x').actions] };
  (browser as any).observe = async () => filled;
  const script = ['f1', 'e1', 'DONE'];
  const histories: number[] = [];
  let asked = 0;
  const result = await run(browser, 'x', {
    choose: async () => decide(script.shift()!),
    text: async () => { asked++; throw new Error('Text helper returned no valid field value; nothing typed.'); },
    verify: async (_page, history) => (histories.push(history.length), { done: true, reason: 'ok' }),
  });
  assert.equal(asked, 1);
  assert.deepEqual(acted, ['e1'], 'the field was skipped and the run went on');
  assert.equal(result.steps[0].stale, 'Text helper returned no valid field value; nothing typed.');
  assert.deepEqual(histories, [1], 'the reviewer received the action history');
});

test("an action's firing click ends the run: it does not wait to see the result, and cannot click twice", async () => {
  // Compile all classes hangs for many minutes on a large org. Clicked, and the page responded: that is the job.
  const { browser, acted } = stub('Apex Classes');
  let asked = 0;
  const result = await run(browser, 'Compile all Apex classes', {
    commit: 'save',                                   // matched against the label, case-insensitively
    choose: async () => (asked++, decide('e1')),      // Jev would click it forever
    verify: async () => assert.fail('an action is not reviewed for completion'),
  });
  assert.deepEqual([result.status, result.started, result.verified], ['done', true, false]);
  assert.deepEqual(acted, ['e1'], 'one click, then stop');
  assert.equal(asked, 1);
});

test('a click that is not the firing control does not end an action run', async () => {
  const { browser, acted } = stub('Sharing Settings');
  const script = ['e2', 'e1'];
  const result = await run(browser, 'Recalculate', { commit: 'Save', choose: async () => decide(script.shift()!) });
  assert.deepEqual(acted, ['e2', 'e1']);
  assert.equal(result.started, true);
});

test("Salesforce's audit trail can end a run as verified, even when the page never shows the proof", async () => {
  // Seen live: Activity Settings saved, Salesforce recorded it, and the run still ended "unverified" because
  // Submit lands on Setup Home and the reviewer could not see the setting.
  const { browser, acted } = stub('Setup Home');
  const records = [{ confirmed: false, probability: 0.1 }, { confirmed: true, probability: 0.93 }];
  const result = await run(browser, 'Turn on the option', {
    choose: async () => decide('e1'),
    verify: async () => ({ done: false, reason: 'The page is Setup Home, so the setting is not visible.' }),
    audit: async () => records.shift()!,
  });
  assert.deepEqual([result.status, result.verified, result.verifiedBy], ['done', true, 'audit']);
  assert.deepEqual(acted, ['e1', 'e1']);
  assert.match(result.steps[1].verdict!.reason, /Setup Audit Trail records the change \(Jev p=0\.93\)/);
});

test('a page confirmation is labelled as such, and a failing audit query does not stop the reviewer', async () => {
  const { browser } = stub('Account Settings');
  const result = await run(browser, 'x', {
    choose: async () => decide('e1'),
    verify: async () => ({ done: true, reason: 'Saved.' }),
    audit: async () => { throw new Error('sf not installed'); },
  });
  assert.deepEqual([result.verified, result.verifiedBy], [true, 'page']);
});

test('when a save lands on Setup Home, the loop reopens the page itself so the saved value can be seen', async () => {
  const home = { ...page('Setup Home'), url: 'https://x.my.salesforce-setup.com/lightning/setup/SetupOneHome/home', fingerprint: 'home' };
  const settings = { ...page('Disable Formulas in Exported Reports: checked'), fingerprint: 'settings' };
  let current = settings;
  const went: string[] = [];
  const browser = {
    observe: async () => current,
    act: async () => { current = home; return 'click'; },
    goto: async (path: string) => { went.push(path); current = { ...settings, fingerprint: 'reopened' }; },
    screenshot: async () => undefined,
  } as any;
  const seenBy: string[] = [];
  const result = await run(browser, 'Turn it on', {
    returnTo: '/lightning/setup/ReportUI/home',
    choose: async () => decide('e1'),
    verify: async (at, history) => (seenBy.push(new URL(at.url).pathname), { done: /Reopened/.test(history.at(-1)!.action), reason: 'ok' }),
  });
  assert.deepEqual(went, ['/lightning/setup/ReportUI/home']);
  assert.deepEqual(seenBy, ['/lightning/setup/AccountSettings/home'], 'the reviewer was shown the settings page, never Setup Home');
  assert.deepEqual([result.status, result.verified], ['done', true]);
});

test('the page is also reopened when the URL stays put but the embedded settings page disappears', async () => {
  const form = page('Disable Formulas: checked');                       // its controls are "(in frame: ...)"
  const bare = { ...form, fingerprint: 'bare', actions: [{ id: 'n1', kind: 'click' as const, label: 'Setup Home', role: 'link', node: '0:1' }, form.actions[2]] };
  let current = form;
  const went: string[] = [];
  const browser = { observe: async () => current, act: async () => { current = bare; return 'click'; },
    goto: async (path: string) => { went.push(path); current = { ...form, fingerprint: 'reopened' }; }, screenshot: async () => undefined } as any;
  const result = await run(browser, 'x', { returnTo: '/lightning/setup/ReportUI/home', choose: async () => decide('e1'), verify: async () => ({ done: true, reason: 'ok' }) });
  assert.deepEqual(went, ['/lightning/setup/ReportUI/home']);
  assert.equal(result.verified, true);
});

test('flipping the toggle it has only just flipped is refused, and a second attempt ends the run', async () => {
  // Seen live on a sandbox: 24 alternating clicks on one checkbox, never Save, until the action budget ran out.
  const { browser, acted } = stub('Deployment Connection');
  const goals: string[] = [];
  const stuck = await run(browser, 'Untick it', { choose: async (_p, goal) => (goals.push(goal), decide('e2')) });
  assert.deepEqual(acted, ['e2'], 'flipped once, never flipped back');
  assert.match(stuck.status, /^stopped: kept toggling "Yes, I understand/);
  assert.match(goals[2], /Do not click it again: that would undo the change\..*click Save/);

  const other = stub('Deployment Connection');
  const script = ['e2', 'e2', 'e1', 'DONE'];
  const moved = await run(other.browser, 'Untick it and save', { choose: async () => decide(script.shift()!) });
  assert.deepEqual(other.acted, ['e2', 'e1'], 'after the refusal it clicked Save');
  assert.equal(moved.status, 'done');
});

test('a click that is not a save never triggers the reopen, even if the embedded page changes', async () => {
  // Seen live: "Erase" led to a confirmation step; reopening the start path there abandoned the erase.
  const list = { ...page('Deleted Fields'), actions: [{ id: 'e9', kind: 'click' as const, label: 'Erase (in frame: Account Deleted Fields)', role: 'link', node: '1:9' }, page('x').actions[2]] };
  const confirmStep = { ...list, fingerprint: 'confirm', actions: [{ id: 'c1', kind: 'click' as const, label: 'Yes, erase it', role: 'button', node: '0:5' }, page('x').actions[2]] };
  let current = list;
  const went: string[] = [];
  const browser = { observe: async () => current, act: async () => { current = confirmStep; return 'click'; },
    goto: async (path: string) => void went.push(path), screenshot: async () => undefined } as any;
  const script = ['e9', 'DONE'];
  await run(browser, 'Erase it', { returnTo: '/lightning/setup/ObjectManager/home', choose: async () => decide(script.shift()!) });
  assert.deepEqual(went, [], 'the confirmation step was left on screen for Jev');
});
