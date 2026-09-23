/** The provider-neutral LLM client, the planner, and the text helper. No paid APIs. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { chatJson, extractJson } from '../src/llm.js';
import { keepsValues, planGoal, planStep, safeStartPath } from '../src/planner.js';
import { fieldText } from '../src/text.js';
import type { Post } from '../src/types.js';

const LLM_ENV = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_TEXT_MODEL', 'LLM_EXTRA_BODY', 'ANTHROPIC_API_KEY'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(LLM_ENV.map((k) => [k, process.env[k]]));
  for (const k of LLM_ENV) delete process.env[k];
  process.env.LLM_API_KEY = 'test';
});
afterEach(() => {
  for (const k of LLM_ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const replying = (content: string, seen: any[] = []): Post => async (url, key, body) => {
  seen.push({ url, key, body });
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 5 } };
};

const PLAN = {
  executable: true,
  reason: 'A Setup toggle.',
  startPath: '/lightning/setup/Flows/home',
  goal: "Activate the flow 'Order Follow Up'.",
  steps: ['Open Flows from Quick Find', "Open 'Order Follow Up'", 'Click Activate'],
  doneWhen: 'The flow shows Active.',
};

test('JSON is accepted bare, fenced, or wrapped in prose; arrays and prose alone are not', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":{"b":2}}\nHope that helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('[1,2]'), /JSON object/);
  assert.throws(() => extractJson('Thinking: Zurich'), /JSON object/);
  assert.throws(() => extractJson(undefined), /no text/);
});

test('defaults to Claude Sonnet on Anthropic’s OpenAI-compatible endpoint, accepting ANTHROPIC_API_KEY', async () => {
  delete process.env.LLM_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  const seen: any[] = [];
  await chatJson('s', 'u', { post: replying('{"ok":true}', seen) });
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal(seen[0].key, 'anthropic-key');
  assert.equal(seen[0].body.model, 'claude-sonnet-5');
  // Anthropic's endpoint answers 400 to response_format json_object. Never send it unasked.
  assert.equal('response_format' in seen[0].body, false);
});

test('any provider plugs in through three variables; ANTHROPIC_API_KEY is not sent elsewhere', async () => {
  process.env.LLM_BASE_URL = 'http://localhost:11434/v1/';
  process.env.LLM_MODEL = 'qwen3';
  const seen: any[] = [];
  await chatJson('s', 'u', { post: replying('{"ok":true}', seen) });
  assert.equal(seen[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen[0].body.model, 'qwen3');

  delete process.env.LLM_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'anthropic-key';
  await assert.rejects(chatJson('s', 'u', { post: replying('{}') }), /LLM_API_KEY is not set/);
});

test('LLM_EXTRA_BODY merges fields, and null removes a default', async () => {
  process.env.LLM_EXTRA_BODY = '{"max_tokens":null,"max_completion_tokens":512,"thinking":{"type":"disabled"}}';
  const seen: any[] = [];
  await chatJson('s', 'u', { post: replying('{"ok":true}', seen) });
  assert.equal('max_tokens' in seen[0].body, false);
  assert.equal(seen[0].body.max_completion_tokens, 512);
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' });
});

test('a valid plan is returned and rendered for Jev', async () => {
  const seen: any[] = [];
  const plan = await planStep('Activate the Order Follow Up flow', { post: replying(JSON.stringify(PLAN), seen) });
  assert.equal(plan.startPath, '/lightning/setup/Flows/home');
  assert.match(JSON.parse(seen[0].body.messages[1].content).manual_step, /Order Follow Up/);
  const goal = planGoal(plan);
  assert.match(goal, /^Activate the flow 'Order Follow Up'\.\nPlan:\n1\. Open Flows/);
  assert.match(goal, /Done when: The flow shows Active\.$/);
});

test('a start path a model wrote is only ever a same-org Lightning path', async () => {
  for (const bad of ['https://evil.example/lightning/x', '//evil.example', '/lightning/../secur/logout.jsp',
    '/secur/frontdoor.jsp', '/lightning/setup//x', 'javascript:alert(1)', 42, null]) {
    assert.equal(safeStartPath(bad), null, String(bad));
  }
  assert.equal(safeStartPath('/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view'),
    '/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view');
  const plan = await planStep('x', { post: replying(JSON.stringify({ ...PLAN, startPath: 'https://evil.example/' })) });
  assert.equal(plan.startPath, null);
});

test('the outcome the audit trail is judged against keeps every value the step spells out', async () => {
  const step = "Set the Partner API URL to https://partner-dev.example.com/queue/ticket?version=OLP and the level to 'System Email Only'.";
  const kept = await planStep(step, { post: replying(JSON.stringify({ ...PLAN,
    outcome: "The Partner API URL was set to https://partner-dev.example.com/queue/ticket?version=OLP and the level to System Email Only." })) });
  assert.match(kept.outcome ?? '', /^The Partner API URL was set/);
  for (const lossy of ['The Partner API URL was updated.', 'The URL was set to https://partner-dev.example.com and the level to System Email Only.']) {
    const plan = await planStep(step, { post: replying(JSON.stringify({ ...PLAN, outcome: lossy })) });
    assert.equal(plan.outcome, undefined, lossy);
  }
  assert.equal((await planStep('x', { post: replying(JSON.stringify(PLAN)) })).outcome, undefined, 'absent is fine');
  assert.ok(keepsValues('Update the username to service.ai@example.com.', 'The username was changed to service.ai@example.com.'));
  assert.ok(!keepsValues('Set batch size to 500.', 'Batch size was changed.'));
});

test('a step that is not a browser step is reported, not forced', async () => {
  const plan = await planStep('Load 2M accounts with Data Loader', {
    post: replying('{"executable":false,"reason":"Needs a data load tool.","startPath":null}'),
  });
  assert.equal(plan.executable, false);
  assert.match(plan.reason, /data load/);
});

test('a malformed plan executes nothing', async () => {
  for (const content of ['not json', '{"executable":true,"reason":"ok"}', JSON.stringify({ ...PLAN, steps: [] }),
    JSON.stringify({ ...PLAN, steps: [1, 2] }), JSON.stringify({ ...PLAN, executable: 'yes' })]) {
    await assert.rejects(planStep('x', { post: replying(content) }), /invalid plan|JSON object/, content);
  }
});

test('typing uses LLM_TEXT_MODEL when set, and rejects anything but one text string', async () => {
  process.env.LLM_TEXT_MODEL = 'claude-haiku-4-5';
  const seen: any[] = [];
  const context = { goal: 'Open Flows', field: { label: 'Quick Find' }, page: { title: '', text: '' }, recent_actions: [] };
  const written = await fieldText(context, { post: replying('{"text":"Flows"}', seen) });
  assert.equal(written.text, 'Flows');
  assert.equal(seen[0].body.model, 'claude-haiku-4-5');
  for (const content of ['Thinking: Flows', '{"text":null}', '{"text":"Flows","extra":true}', '{"text":123}', '{"text":"  "}']) {
    await assert.rejects(fieldText(context, { post: replying(content) }), /nothing typed/, content);
  }
});

test('a dropdown field accepts only one of its own options, verbatim', async () => {
  const context = { goal: 'Brisbane time', field: { label: 'Time Zone', options: ['(GMT+10:00) Brisbane', '(GMT+10:00) Sydney'] }, page: { title: '', text: '' }, recent_actions: [] };
  const seen: any[] = [];
  const ok = await fieldText(context, { post: replying('{"text":"(GMT+10:00) Brisbane"}', seen) });
  assert.equal(ok.text, '(GMT+10:00) Brisbane');
  assert.deepEqual(JSON.parse(seen[0].body.messages[1].content).field.options.length, 2, 'the options reach the LLM');
  await assert.rejects(fieldText(context, { post: replying('{"text":"Brisbane"}') }), /nothing typed/, 'a paraphrase is refused');
});
