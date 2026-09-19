/**
 * The "thinking" LLM: plans the step and writes field values. Any OpenAI-compatible chat/completions endpoint.
 * Defaults to Claude Sonnet through Anthropic's OpenAI-compatible endpoint; change three variables to swap it.
 *
 *   LLM_BASE_URL    default https://api.anthropic.com/v1
 *   LLM_API_KEY     falls back to ANTHROPIC_API_KEY when the base URL is Anthropic's
 *   LLM_MODEL       default claude-sonnet-5
 *   LLM_EXTRA_BODY  JSON merged into every request; a null value removes a default field
 */

import { postJson } from './http.js';
import type { Post } from './types.js';

const ANTHROPIC = 'https://api.anthropic.com/v1';

export interface LlmReply {
  json: Record<string, unknown>;
  model: string;
  latencyMs: number;
  usage: Record<string, number>;
}

export interface LlmOptions {
  post?: Post;
  model?: string;
  maxTokens?: number;
}

/**
 * JSON mode is not portable: providers disagree on response_format (Anthropic's endpoint rejects json_object
 * with a 400, despite documenting the field as ignored). So it is never sent by default; the prompt asks for
 * JSON and the reply is parsed tolerantly. Opt in per provider with LLM_EXTRA_BODY.
 */
export function extractJson(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') throw new Error('LLM returned no text');
  const candidates = [content, content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')];
  const open = content.indexOf('{');
  const close = content.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(content.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      continue;
    }
  }
  throw new Error('LLM did not return a JSON object');
}

export async function chatJson(system: string, user: string, options: LlmOptions = {}): Promise<LlmReply> {
  const base = (process.env.LLM_BASE_URL ?? ANTHROPIC).replace(/\/$/, '');
  const key = process.env.LLM_API_KEY ?? (base === ANTHROPIC ? process.env.ANTHROPIC_API_KEY : undefined);
  if (!key) throw new Error('LLM_API_KEY is not set (or ANTHROPIC_API_KEY for the default Claude endpoint)');
  const model = options.model ?? process.env.LLM_MODEL ?? 'claude-sonnet-5';

  let extra: Record<string, unknown> = {};
  if (process.env.LLM_EXTRA_BODY) {
    try {
      extra = JSON.parse(process.env.LLM_EXTRA_BODY);
    } catch {
      throw new Error('LLM_EXTRA_BODY is not valid JSON');
    }
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? 2048,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...extra,
  };
  for (const [field, value] of Object.entries(body)) if (value === null) delete body[field];

  const started = performance.now();
  const result = await (options.post ?? postJson)(`${base}/chat/completions`, key, body);
  return {
    json: extractJson(result?.choices?.[0]?.message?.content),
    model,
    latencyMs: Math.round(performance.now() - started),
    usage: result?.usage ?? {},
  };
}
