import type { Post } from './types.js';

const RETRYABLE = new Set([429, 503, 529]);

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
    return response.json();
  }
  throw new Error('Model unavailable');
};
