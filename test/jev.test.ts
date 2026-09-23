/** Offline contracts for the operation/target policy. No paid APIs. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionSpace, choose, mostRelevant, validateChoice } from '../src/jev.js';
import type { Page } from '../src/types.js';

function page(): Page {
  return {
    url: 'https://example.my.salesforce-setup.com/lightning/setup/SetupOneHome/home',
    title: 'Setup',
    text: 'Setup Home',
    fingerprint: 'x',
    stats: [],
    actions: [
      { id: 'e1', kind: 'fill', label: 'Quick Find', role: 'searchbox', value: '', node: '0:10' },
      { id: 'e2', kind: 'click', label: 'Open Quick Find', role: 'searchbox', value: '', node: '0:10' },
      { id: 'e3', kind: 'click', label: 'Save', role: 'button', value: '', node: '0:20' },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ],
  };
}

const answer = (ids: string[], selected: string) => ({
  choice: selected,
  confidence: 1,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
});

for (const mutation of ['unknown', 'nan', 'missing', 'negative', 'non_max', 'confidence', 'extra'] as const) {
  test(`invalid choice is rejected: ${mutation}`, () => {
    const a: any = answer(['a', 'b'], 'a');
    if (mutation === 'unknown') a.choice = 'invented';
    if (mutation === 'nan') a.probabilities.a = Number.NaN;
    if (mutation === 'missing') delete a.probabilities.b;
    if (mutation === 'negative') a.probabilities.b = -1;
    if (mutation === 'non_max') a.choice = 'b';
    if (mutation === 'confidence') a.confidence = 5;
    if (mutation === 'extra') a.probabilities.c = 0;
    assert.throws(() => validateChoice(a, ['a', 'b']), /Invalid TypeSafe/);
  });
}

test('one index per node, with operation-specific targets', () => {
  const { elements, targets, controls } = actionSpace(page().actions);
  assert.equal(elements.length, 2);
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.equal(targets.TYPE_TEXT['1'].id, 'e1');
  assert.equal(targets.CLICK['1'].id, 'e2');
  assert.equal(targets.CLICK['2'].id, 'e3');
  assert.ok('WAIT' in controls);
});

test('select options get element:option indices', () => {
  const { elements, targets } = actionSpace([
    { id: 'e1', kind: 'select', label: 'Run as → System', node: '1:4', value: 'sys', current_value: 'User', option_index: 1 },
    { id: 'e2', kind: 'select', label: 'Run as → Guest', node: '1:4', value: 'guest', current_value: 'User', option_index: 2 },
  ]);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].value, 'User');
  assert.deepEqual(Object.keys(targets.SELECT), ['1:1', '1:2']);
  assert.equal(targets.SELECT['1:2'].id, 'e2');
});

test('all heads go in one request and only the matching head executes', async () => {
  const bodies: any[] = [];
  const decision = await choose(page(), 'Open Flows', [], {
    apiKey: 'test',
    post: async (url, _key, body: any) => {
      bodies.push({ url, body });
      return {
        model: 'test',
        answers: {
          operation: answer(Object.keys(body.questions.operation.criteria), 'TYPE_TEXT'),
          type_text_target: answer(['1'], '1'),
          click_target: { choice: 'invented' }, // malformed, but unused: must not matter
        },
      };
    },
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(Object.keys(bodies[0].body.questions).sort(), ['click_target', 'operation', 'type_text_target']);
  assert.deepEqual([decision.operation, decision.target, decision.choice], ['TYPE_TEXT', '1', 'e1']);
});

test('an invented target for the chosen operation executes nothing', async () => {
  await assert.rejects(
    choose(page(), 'Save', [], {
      apiKey: 'test',
      post: async (_url, _key, body: any) => ({
        model: 'test',
        answers: {
          operation: answer(Object.keys(body.questions.operation.criteria), 'CLICK'),
          click_target: answer(['1', '2', '999'], '999'),
        },
      }),
    }),
    /Invalid TypeSafe/,
  );
});

test('target heads carry control state and name the operation they assume', async () => {
  const p = page();
  p.actions.unshift({ id: 'e0', kind: 'click', label: 'Enable', role: 'checkbox', checked: 'true', node: '0:30' });
  const decision = await choose(p, 'Enable it', [], {
    apiKey: 'test',
    post: async (_url, _key, body: any) => {
      const target = body.questions.click_target;
      assert.equal(target.criteria['1'].checked, 'true');
      assert.equal(target.instructions.operation, 'CLICK');
      return {
        model: 'test',
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: {
          operation: answer(Object.keys(body.questions.operation.criteria), 'CLICK'),
          click_target: answer(Object.keys(target.criteria), '3'),
        },
      };
    },
  });
  assert.equal(decision.choice, 'e3');
  assert.equal(decision.usage.input_tokens, 10);
});

test('DONE needs no target head', async () => {
  const decision = await choose(page(), 'x', [], {
    apiKey: 'test',
    post: async (_url, _key, body: any) => ({
      model: 'test',
      answers: { operation: answer(Object.keys(body.questions.operation.criteria), 'DONE') },
    }),
  });
  assert.deepEqual([decision.choice, decision.target], ['DONE', null]);
});

test('when Jev says the request is too large, it is retried with the controls most relevant to the goal', async () => {
  const p = page();
  p.actions = [
    ...Array.from({ length: 200 }, (_, i) => ({ id: `e${i + 1}`, kind: 'click' as const, label: `Account rule ${i}`, role: 'link', node: `1:${i}` })),
    { id: 'e201', kind: 'click', label: 'Recalculate (row: Lead Sharing Rules New Recalculate)', role: 'button', node: '1:900' },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ];
  const sizes: number[] = [];
  const decision = await choose(p, 'Recalculate the sharing rules for Lead.', [], {
    apiKey: 'test',
    post: async (_url, _key, body: any) => {
      const ids = Object.keys(body.questions.click_target.criteria);
      sizes.push(ids.length);
      if (ids.length > 120) throw new Error('Model provider returned HTTP 400; no action executed. {"detail":{"error_type":"max_tokens_exceeded"}}');
      const pick = ids.find((id) => body.questions.click_target.criteria[id].element.includes('Lead Sharing Rules'))!;
      return { model: 'test', answers: { operation: answer(Object.keys(body.questions.operation.criteria), 'CLICK'), click_target: answer(ids, pick) } };
    },
  });
  assert.deepEqual(sizes, [201, 120], 'full table first, then the 120 most relevant');
  assert.equal(decision.choice, 'e201', 'the far-down control that matches the goal survived the cut, and maps to the right action');
});

test('a page longer than the table reaches Jev as the 250 controls most relevant to the goal', async () => {
  // Seen live: Named Credentials, alphabetical; a cut by position ended one record before "Partner API".
  const p = page();
  p.actions = [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `e${i + 1}`, kind: 'click' as const, label: `Show actions (row: Credential ${i})`, role: 'button', node: `0:${i}` })),
    { id: 'e301', kind: 'click', label: 'Show actions (row: Partner API Partner API External Credential)', role: 'button', node: '0:900' },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ];
  const sizes: number[] = [];
  const decision = await choose(p, 'Edit the named credential Partner API.', [], {
    apiKey: 'test',
    post: async (_url, _key, body: any) => {
      const ids = Object.keys(body.questions.click_target.criteria);
      sizes.push(ids.length);
      const pick = ids.find((id) => body.questions.click_target.criteria[id].element.includes('Partner API'))!;
      return { model: 'test', answers: { operation: answer(Object.keys(body.questions.operation.criteria), 'CLICK'), click_target: answer(ids, pick) } };
    },
  });
  assert.deepEqual(sizes, [250]);
  assert.equal(decision.choice, 'e301');
});

test('in a tie, the embedded Setup page outranks the sidebar around it', () => {
  const kept = mostRelevant([
    { id: 'e1', kind: 'click', label: 'Sidebar link', node: '0:1', in_viewport: true },
    { id: 'e2', kind: 'click', label: 'Manage (in frame: Custom Settings)', node: '1:2', in_viewport: false },
    { id: 'wait', kind: 'wait', label: 'Wait' },
  ], 'Turn off Production', 1);
  assert.deepEqual(kept.map((a) => a.id), ['e2', 'wait']);
});

test('relevance keeps goal-matching controls, then on-screen ones, in page order, and never drops WAIT', () => {
  const kept = mostRelevant([
    { id: 'e1', kind: 'click', label: 'Nav A', node: '0:1', in_viewport: false },
    { id: 'e2', kind: 'click', label: 'Nav B', node: '0:2', in_viewport: true },
    { id: 'e3', kind: 'click', label: 'Recalculate Lead', node: '1:3', in_viewport: false },
    { id: 'wait', kind: 'wait', label: 'Wait' },
  ], 'Recalculate sharing for Lead', 2);
  assert.deepEqual(kept.map((a) => a.id), ['e2', 'e3', 'wait']);
});
