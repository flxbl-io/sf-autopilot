/**
 * One frame's indexed controls. Adapted from jev_ultrafast/snapshot.js (MIT, Browser Use), with three changes:
 * it descends open shadow roots, it keeps offscreen controls (Playwright scrolls a target into view before
 * input), and it runs once per frame so embedded Classic Setup pages are part of the table.
 *
 * Playwright serialises this function with toString() and runs it inside the page. It must not reference
 * anything outside its own body.
 */

export interface FrameAction {
  node: number;
  role: string;
  label: string;
  kind: 'click' | 'fill' | 'select';
  in_viewport: boolean;
  value?: string;
  current_value?: string;
  option_index?: number;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** A long dropdown offered as one target: the option is named in text and must be one of these, verbatim. */
  options?: string[];
}

export interface FrameState {
  url: string;
  title: string;
  text: string;
  actions: FrameAction[];
  stats: { open_shadow_roots: number; closed_shadow_suspects: number; query_selector_all: number; walked: number };
}

export function readFrame(): FrameState | null {
  if (!document.body) return null;
  const w = window as any;
  const cache: { ids: WeakMap<Element, number>; nodes: Map<number, Element>; next: number } = (w.__sfAutopilot ||= {
    ids: new WeakMap(),
    nodes: new Map(),
    next: 1,
  });
  const identity = (e: Element): number => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e)!;
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);

  // Password, file and hidden inputs are never read, so their values never reach a model.
  const safe = (e: any) => !['password', 'file', 'hidden'].includes(e.type);
  const rendered = (e: any) =>
    !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const sized = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // SLDS toggles and radio groups clip the real input to 1px and draw its label instead.
  const toggle = (e: any) => e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type);
  const visible = (e: any) =>
    (rendered(e) && sized(e)) || (toggle(e) && [...(e.labels || [])].some((l: any) => rendered(l) && sized(l)));
  const byId = (e: any, id: string) => e.getRootNode().getElementById?.(id) || document.getElementById(id);
  const name = (e: any, seen = new Set<any>()): string => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id: string) => name(byId(e, id), seen))
      .filter(Boolean)
      .join(' ');
    return (
      referenced ||
      e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l: any) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
      e.getAttribute('alt') ||
      (e.tagName === 'INPUT'
        ? ''
        : [...e.childNodes]
            .map((n: any) =>
              n.nodeType === 3 ? n.textContent : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '',
            )
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()) ||
      e.getAttribute('title') ||
      e.getAttribute('placeholder') ||
      ''
    );
  };

  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'menuitemcheckbox', 'option', 'treeitem', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const native =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' + roles.map((r) => `[role="${r}"]`).join(',');
  // Conventional custom clickables. Kept only when named and not wrapping a real control.
  const custom = '[onclick],[tabindex="0"]';
  const role = (e: any): string | null => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
      return null;
    }
    return e.matches(custom) ? 'button' : null;
  };

  // A TreeWalker sees the real tree even where a shadow polyfill patches querySelectorAll.
  const found: any[] = [];
  const texts: any[] = [];
  const stats = { open_shadow_roots: 0, closed_shadow_suspects: 0, query_selector_all: 0, walked: 0 };
  const walk = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n: any;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        texts.push(n);
        continue;
      }
      if (n.matches(native) || n.matches(custom)) found.push(n);
      // Classic Setup draws read-only state as an image: <img alt="Checked">. Without its alt text, the proof
      // that a setting was saved is invisible to every model.
      if (n.tagName === 'IMG' && (n.getAttribute('alt') || '').trim()) texts.push(n);
      if (n.shadowRoot) {
        stats.open_shadow_roots++;
        walk(n.shadowRoot);
      } else if (n.tagName.includes('-') && !n.childNodes.length && sized(n)) stats.closed_shadow_suspects++;
    }
  };
  walk(document.body);
  stats.query_selector_all = document.querySelectorAll(native).length;
  stats.walked = found.filter((e) => e.matches(native)).length;

  const actions: FrameAction[] = [];
  const owners = new Map<number, any>();
  // A disabled control cannot be acted on, but it is often the only proof a setting was saved: Classic Setup
  // shows a saved checkbox as <input type="checkbox" disabled>. Its state is reported as a fact, never a target.
  const facts: string[] = [];
  for (const e of found) {
    if (!safe(e) || !visible(e)) continue;
    if (e.matches(':disabled') || e.closest('[aria-disabled="true"]')) {
      const label = name(e);
      if (!label || facts.length >= 40) continue;
      if (toggle(e)) facts.push(`${label}: ${e.checked ? 'checked' : 'not checked'} (read-only)`);
      else if (e.tagName === 'SELECT') facts.push(`${label}: ${[...e.selectedOptions].map((o: any) => o.label).join(', ')} (read-only)`);
      else if (e.getAttribute('aria-checked') !== null) facts.push(`${label}: ${e.getAttribute('aria-checked') === 'true' ? 'checked' : 'not checked'} (read-only)`);
      else if (['INPUT', 'TEXTAREA'].includes(e.tagName) && e.value) facts.push(`${label}: ${String(e.value).slice(0, 80)} (read-only)`);
      continue;
    }
    // A frame is a container, not a control: clicking one lands on whatever sits at its centre. Its contents
    // are read separately, frame by frame.
    if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(e.tagName)) continue;
    const rname = role(e);
    if (!rname) continue;
    // A row that wraps a real link or button is the same target twice. Keep the inner control: it is the
    // safer click, and the Setup tree alone would otherwise double the table.
    if (['gridcell', 'treeitem'].includes(rname) && e.querySelector('a[href],button,[role="button"],[role="link"]')) continue;
    let label = name(e);
    // A Lightning datatable makes every cell focusable for keyboard navigation and draws its text in a shadow root,
    // so each cell reads as an unnamed "gridcell". Seen live on Named Credentials: four per row, the table filled up
    // at the fortieth record, and the one the step named was never offered. The row's real controls (its link,
    // "Show actions") are read on their own; an unnamed cell adds nothing a model could choose between.
    if (rname === 'gridcell' && !label) continue;
    // A <select> with no accessible name would otherwise be named by its own options. Classic Setup keeps the
    // field's label in the cell to its left, with no <label for>, so look there.
    if (e.tagName === 'SELECT' && !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.labels?.length || e.getAttribute('title'))) {
      const cell = e.closest('td,th')?.previousElementSibling;
      label = (cell?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'dropdown';
    }
    // The same holds for a Classic text field. Seen live: the connected app's "Run As" lookup was offered as
    // "textbox", and only luck put the user's name in the right one.
    if (!label && ['textbox', 'searchbox', 'spinbutton'].includes(rname)) {
      const cell = e.closest('td,th')?.previousElementSibling;
      label = (cell?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    // Classic settings pages often give a checkbox no label at all: the words sit in the same table row.
    if (toggle(e) && !label) label = (e.closest('tr,li')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!e.matches(native) && (!label || label.length > 80 || e.querySelector(native))) continue;
    const r = e.getBoundingClientRect();
    owners.set(identity(e), e);
    const base: any = {
      node: identity(e),
      role: rname,
      label: (label || rname).slice(0, 160),
      in_viewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (toggle(e)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      const current = [...e.selectedOptions].map((o: any) => o.label).join(', ');
      // One action per option does not scale. Seen live: Default Locale's hundreds of options filled the whole
      // table, so the Time Zone dropdown the step needed was never offered. A long dropdown is one target
      // instead, filled like a text field: the LLM names the option and it must match one verbatim.
      const choosable = [...e.options].filter((o: any) => !o.disabled && !o.closest('optgroup[disabled]'));
      if (choosable.length > 12) {
        actions.push({ ...base, kind: 'fill', value: current, label: `${base.label} (dropdown, ${choosable.length} options)`,
          options: choosable.slice(0, 800).map((o: any) => o.label) });
        continue;
      }
      [...e.options].forEach((o: any, option_index: number) => {
        if (o.selected || o.disabled || o.closest('optgroup[disabled]')) return;
        actions.push({ ...base, kind: 'select', value: o.value, option_index, current_value: current, label: `${base.label} → ${o.label}` });
      });
    } else {
      const editable =
        !e.readOnly &&
        e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) || (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const raw = 'value' in e ? String(e.value) : e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      const value = raw.slice(0, 400);
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
    }
  }

  // Classic list pages (Custom Settings, Manage Connected Apps) have no search box, only an A-Z row of one-letter
  // links above the list. Seen live: the letter "L" was on screen while the record was off the first page, and Jev,
  // offered a bare link called "L", gave up. A letter in such a row says what it does.
  for (const a of actions) {
    if (a.kind !== 'click' || !/^([A-Z]|Other|All)$/.test(a.label)) continue;
    const row = owners.get(a.node)?.parentElement?.closest('div,td,ul,span,p');
    const letters = row ? [...row.querySelectorAll('a')].filter((l: any) => /^[A-Z]$/.test((l.textContent || '').trim())).length : 0;
    if (letters < 20) continue;
    a.label = a.label === 'All' ? 'All (list filter: show every record)'
      : a.label === 'Other' ? 'Other (list filter: records whose name starts with a digit or symbol)'
      : `${a.label} (list filter: show only records whose name starts with ${a.label})`;
  }

  // A table of records has one "Remove" / "Edit" / "Del" per row, all labelled alike. Seen live: asked to release
  // one component from a package, the agent chose among four identical "Remove" links blind and released two.
  // A label shared by several controls therefore gains the text of its own row.
  const shared = new Map<string, number>();
  for (const a of actions) if (a.kind === 'click') shared.set(a.label, (shared.get(a.label) || 0) + 1);
  for (const a of actions) {
    if (a.kind !== 'click' || (shared.get(a.label) || 0) < 2) continue;
    const row = owners.get(a.node)?.closest('tr,[role="row"],li,[role="listitem"]');
    const context = (row?.innerText || '').replace(/\s+/g, ' ').trim();
    if (context && context !== a.label) a.label = `${a.label} (row: ${context.slice(0, 120)})`;
  }

  // Visible text, what is on screen first.
  const near: string[] = [];
  const far: string[] = [];
  const range = document.createRange();
  let length = 0;
  for (const node of texts) {
    if (length >= 12000) break;
    const image = node.nodeType === 1;
    const value = (image ? `[${node.getAttribute('alt')}]` : node.textContent || '').replace(/\s+/g, ' ').trim();
    const parent = image ? node : node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !rendered(parent)) continue;
    if (!image) range.selectNodeContents(node);
    const r = image ? node.getBoundingClientRect() : range.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? near : far).push(value);
    length += value.length;
  }
  return { url: location.href, title: document.title, text: [...facts, ...near, ...far].join('\n').slice(0, 6000), actions, stats };
}
