/**
 * Jev's DONE is an opinion. On a live org it declared DONE while Salesforce's "this permanently deletes data"
 * confirmation was still open. So a DONE is checked by the LLM against the plan's done-condition before it
 * counts, and a rejection goes back to Jev as a note.
 *
 * This is still a model reading a page. It catches an unanswered dialog or an unsaved form; it does not
 * replace checking the org's real state.
 */

import { chatJson, type LlmOptions } from './llm.js';
import { VERIFY } from './prompts.js';
import type { SavedRecord } from './record.js';
import type { Page } from './types.js';

export interface Verdict {
  done: boolean;
  reason: string;
}

export interface Evidence {
  /** What the agent just did, oldest first. Lets the reviewer tell a saved value from a typed one. */
  recentActions?: { action: string; kind: string; text: string | null }[];
  /** The page was just opened in a new browser session, so what it shows is what is saved. */
  freshSession?: boolean;
  /** The record the page shows, read from the org: what is saved, whatever the page draws. */
  record?: SavedRecord | null;
}

export async function verifyDone(doneWhen: string, page: Page, options: LlmOptions & Evidence = {}): Promise<Verdict> {
  const controls = page.actions
    .filter((a) => a.kind !== 'wait')
    .map(({ label, role, checked, value, current_value }) => ({ label, role, checked, value: current_value ?? value }))
    // Stateful controls and anything inside an embedded page carry the evidence; the Setup tree does not.
    .filter((c) => c.checked !== undefined || c.value || /in frame:/.test(c.label) || c.role === 'button')
    .slice(0, 120);
  let reply;
  try {
    reply = await chatJson(VERIFY, JSON.stringify({
    done_when: doneWhen,
    page: { title: page.title, path: new URL(page.url).pathname, text: page.text.slice(0, 6000) },
    controls,
    recent_actions: options.recentActions ?? [],
    fresh_session: options.freshSession ?? false,
    ...(options.record ? { saved_record: options.record } : {}),
    }), { maxTokens: 1024, post: options.post, model: options.model });
  } catch (error) {
    // Seen live: a reply that was not JSON ended a run that had done nothing wrong. No verdict is a "no".
    if (!/JSON object|no text/.test((error as Error).message)) throw error;
    return { done: false, reason: 'The reviewer returned no usable verdict.' };
  }
  const { done, reason } = reply.json;
  if (typeof done !== 'boolean' || typeof reason !== 'string') {
    // An unreadable verdict must never count as a confirmation.
    return { done: false, reason: 'The reviewer returned no usable verdict.' };
  }
  return { done, reason: reason.slice(0, 400) };
}
