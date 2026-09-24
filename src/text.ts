/** The LLM writes a field value. It is called only when Jev chooses TYPE_TEXT; it never chooses what to click. */

import { chatJson, type LlmOptions } from './llm.js';
import { TEXT_VALUE, TOGGLE } from './prompts.js';
import type { Action, HistoryEntry, Page } from './types.js';

export interface FieldContext {
  goal: string;
  field: { label: string; role?: string; value?: string; options?: string[] };
  page: { title: string; text: string };
  recent_actions: { action: string; text: string | null }[];
}

export interface TextResult {
  text: string;
  model: string;
  latencyMs: number;
  usage: Record<string, number>;
}

export function fieldContext(goal: string, action: Action, page: Page, history: HistoryEntry[]): FieldContext {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value, options: action.options },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
  };
}

export async function fieldText(context: FieldContext, options: LlmOptions = {}): Promise<TextResult> {
  let reply;
  try {
    // LLM_TEXT_MODEL lets typing use a smaller, faster model than planning.
    reply = await chatJson(TEXT_VALUE, JSON.stringify(context), {
      maxTokens: 1024,
      model: process.env.LLM_TEXT_MODEL,
      ...options,
    });
  } catch (error) {
    if ((error as Error).message.startsWith('LLM did not return') || (error as Error).message === 'LLM returned no text') {
      throw new Error('Text helper returned no valid field value; nothing typed.');
    }
    throw error;
  }
  const { text } = reply.json;
  if (Object.keys(reply.json).length !== 1 || typeof text !== 'string' || !text.trim() || text.length > 2000) {
    throw new Error('Text helper returned no valid field value; nothing typed.');
  }
  // A dropdown takes one of its own options and nothing else.
  if (context.field.options && !context.field.options.includes(text)) {
    throw new Error('Text helper returned no valid field value; nothing typed.');
  }
  return { text, model: reply.model, latencyMs: reply.latencyMs, usage: reply.usage };
}

/**
 * Should this toggle end up checked? true, false, or null when the goal does not say. Seen live: "tick Mobile Opt
 * Out" met a box that was already ticked, the agent clicked it, saved, and turned the tracking off. Asked before
 * every toggle click; an unreadable answer is null, which never blocks a click.
 */
export async function toggleIntent(goal: string, label: string, options: LlmOptions = {}): Promise<boolean | null> {
  try {
    const reply = await chatJson(TOGGLE, JSON.stringify({ goal, control: label }), { maxTokens: 64, model: process.env.LLM_TEXT_MODEL, ...options });
    return typeof reply.json.checked === 'boolean' ? reply.json.checked : null;
  } catch {
    return null;
  }
}
