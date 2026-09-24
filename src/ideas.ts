/**
 * When the agent is stuck, the LLM looks at the page it is on and suggests what might be worth trying. The ideas are
 * read from the live page, not written in advance, so a Salesforce release that moves a button changes the ideas
 * instead of breaking them. They go to Jev as context; Jev still chooses every action, from observed controls only.
 */

import { mostRelevant } from './jev.js';
import { chatJson, type LlmOptions } from './llm.js';
import { IDEAS } from './prompts.js';
import type { HistoryEntry, Page } from './types.js';

export interface IdeaContext {
  goal: string;
  stuck: string;
  page: { title: string; url: string; text: string };
  controls: string[];
  recent_actions: { action: string; text: string | null }[];
}

export function ideaContext(goal: string, stuck: string, page: Page, history: HistoryEntry[]): IdeaContext {
  const controls = mostRelevant(page.actions, goal, 150).filter((a) => a.kind !== 'wait').map((a) => a.label.slice(0, 120));
  return {
    goal,
    stuck,
    page: { title: page.title, url: new URL(page.url).pathname, text: page.text.slice(0, 3000) },
    controls: [...new Set(controls)],
    recent_actions: history.slice(-8).map((h) => ({ action: h.action.slice(0, 120), text: h.text })),
  };
}

/** Up to three short ideas, or none. Anything malformed is dropped: an idea never executes, so none is no loss. */
export async function pageIdeas(context: IdeaContext, options: LlmOptions = {}): Promise<string[]> {
  try {
    const reply = await chatJson(IDEAS, JSON.stringify(context), { maxTokens: 600, model: process.env.LLM_TEXT_MODEL, ...options });
    const ideas = reply.json.ideas;
    if (!Array.isArray(ideas)) return [];
    return ideas.filter((i): i is string => typeof i === 'string' && i.trim() !== '').map((i) => i.trim().slice(0, 240)).slice(0, 3);
  } catch {
    return [];
  }
}
