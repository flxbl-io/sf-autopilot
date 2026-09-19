export type Kind = 'click' | 'fill' | 'select' | 'wait';

/** One executable thing observed on the page. Jev can only ever choose one of these. */
export interface Action {
  id: string;
  kind: Kind;
  label: string;
  /** Code-owned identity of the DOM node, unique across frames. Never produced by a model. */
  node?: string;
  role?: string;
  value?: string;
  current_value?: string;
  option_index?: number;
  /** A long dropdown offered as one 'fill' target: the text must be one of these, verbatim. */
  options?: string[];
  checked?: string;
  selected?: string;
  expanded?: string;
  in_viewport?: boolean;
}

export interface FrameStats {
  frame: number;
  url: string;
  open_shadow_roots: number;
  closed_shadow_suspects: number;
  query_selector_all: number;
  walked: number;
}

export interface Page {
  url: string;
  title: string;
  text: string;
  actions: Action[];
  fingerprint: string;
  stats: FrameStats[];
  /** A native confirm() that warned of permanent data loss. It was cancelled, and the run must stop. */
  blockedDialog?: string;
}

export interface HistoryEntry {
  action: string;
  kind: Kind;
  text: string | null;
  page_changed: boolean | null;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface Decision {
  /** An Action id, or DONE / BLOCKED. */
  choice: string;
  operation: string;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  operationProbabilities: Record<string, number>;
  targetConfidence: number | null;
  model: string;
  usage: Record<string, number>;
  latencyMs: number;
}

/** Transport for a model request. Injected in tests so no paid API is ever called. */
export type Post = (url: string, key: string, body: unknown) => Promise<any>;
