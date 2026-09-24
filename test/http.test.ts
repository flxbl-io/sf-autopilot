/** The usage meter: counts what each provider reports, keeps no content. No network. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meter, usage } from '../src/http.js';

test('Jev and OpenAI-compatible usage are counted apart, in either field style', () => {
  const before = { jev: { ...usage.jev }, llm: { ...usage.llm } };
  meter('https://api.typesafe.ai/v1/systemone', { usage: { input_tokens: 100, output_tokens: 5 } });
  meter('https://api.anthropic.com/v1/chat/completions', { usage: { prompt_tokens: 40, completion_tokens: 7 } });
  meter('https://api.anthropic.com/v1/chat/completions', {});
  meter('https://example.com/other', { usage: { input_tokens: 999 } });
  assert.deepEqual([usage.jev.calls - before.jev.calls, usage.jev.inputTokens - before.jev.inputTokens, usage.jev.outputTokens - before.jev.outputTokens], [1, 100, 5]);
  assert.deepEqual([usage.llm.calls - before.llm.calls, usage.llm.inputTokens - before.llm.inputTokens, usage.llm.outputTokens - before.llm.outputTokens], [2, 40, 7]);
});
