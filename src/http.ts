import type { Post } from './types.js';

const RETRYABLE = new Set([429, 503, 529]);

/**
 * Every model call a process made, and the tokens each provider reported, so a run's cost is measured rather than
 * guessed. Jev (/systemone) reports input_tokens / output_tokens; an OpenAI-compatible endpoint (/chat/completions)
 * reports prompt_tokens / completion_tokens. Counts only: no prompt or reply is kept.
 */
export interface Meter {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
export const usage: { jev: Meter; llm: Meter } = {
  jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
  llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
};

export function meter(url: string, result: any): void {
  const which = /\/systemone$/.test(url) ? usage.jev : /\/chat\/completions$/.test(url) ? usage.llm : null;
  if (!which) return;
  const u = result?.usage ?? {};
  which.calls++;
  which.inputTokens += Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  which.outputTokens += Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
}

/** Model requests only. Safe to retry because nothing here touches the browser. */
export const postJson: Post = async (url, key, body) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new Error('Model connection failed; no action executed.');
    }
    if (RETRYABLE.has(response.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      // A 4xx body says what was wrong with the request. It never contains the key, which travels in a header.
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Model provider returned HTTP ${response.status}; no action executed.${detail ? ` ${detail}` : ''}`);
    }
    const result = await response.json();
    meter(url, result);
    return result;
  }
  throw new Error('Model unavailable');
};
