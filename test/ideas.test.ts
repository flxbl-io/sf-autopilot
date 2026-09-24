/** Ideas are text for Jev, never actions. Only the HTTP layer is faked. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageIdeas } from '../src/ideas.js';

const context = { goal: 'g', stuck: 's', page: { title: 't', url: '/x', text: '' }, controls: ['Show More'], recent_actions: [] };
const reply = (content: string) => async () => ({ choices: [{ message: { content } }], usage: {} });

test('at most three ideas are kept, trimmed; anything malformed gives none', async () => {
  process.env.LLM_API_KEY ??= 'test';
  assert.deepEqual(await pageIdeas(context, { post: reply('{"ideas": [" a ", "b", "c", "d"]}') }), ['a', 'b', 'c']);
  assert.deepEqual(await pageIdeas(context, { post: reply('{"ideas": "open it"}') }), []);
  assert.deepEqual(await pageIdeas(context, { post: reply('not json') }), []);
  assert.deepEqual(await pageIdeas(context, { post: async () => { throw new Error('offline'); } }), []);
});
