/** Playwright reads and drives the page. Every displayed frame is observed; open shadow roots are included. */

import { createHash } from 'node:crypto';
import { chromium, errors, type Browser, type BrowserContext, type ElementHandle, type Frame, type Page as PwPage, type Request } from 'playwright';
import { DESTRUCTIVE } from './guards.js';
import { readFrame } from './snapshot.js';
import type { Action, FrameStats, Page } from './types.js';

/**
 * How many controls one observation reads. Jev is shown at most TABLE_LIMIT of them (jev.ts), picked for the step;
 * this ceiling only guards against a pathological page. Seen live: Named Credentials lists some 80 records, and
 * reading stopped at 250 on the record just before the one the step named.
 */
const MAX_ACTIONS = 600;

/** The chosen element is gone or cannot take input. Nothing was executed; observe and choose again. */
export class Stale extends Error {}

export interface BrowserOptions {
  /** After sign-in, go here unless the sign-in URL already landed on it. */
  startPath?: string;
  headless?: boolean;
  /** Default 'chrome': the installed Google Chrome. '' uses Playwright's bundled Chromium. */
  channel?: string;
  /** Accept a native dialog even when it warns of permanent data loss. */
  allowDestructive?: boolean;
  /** Where to put the visible browser window, in screen points. For demos and for watching a run beside a terminal. */
  window?: { x: number; y: number; width: number; height: number };
}

export class PlaywrightBrowser {
  page!: PwPage;
  private browser!: Browser;
  private context!: BrowserContext;
  private refs = new Map<string, { frame: Frame; node: number }>();
  /**
   * Document requests still in flight, in any frame or tab. This is the only dependable sign that a page is
   * about to be replaced: while a form post awaits its response the old document stays on screen, still
   * reports readyState 'complete', and has long since reached network idle.
   */
  private navigating = new Set<Request>();
  /** How many frames carried controls at the last settled observation. */
  private contentFrames = 0;
  /** The URL of the last settled observation. Arriving somewhere new earns a more patient look. */
  private settledUrl = '';
  /**
   * Native alert()/confirm() boxes are not in the DOM, so no model can see or click them, and Playwright cancels
   * them silently when nobody listens: a Classic "Remove" link would then quietly do nothing. They are answered
   * here, and what they said is shown to the models in the next observation.
   */
  private dialogs: string[] = [];
  private blockedDialog: string | undefined;
  private allowDestructive = false;

  static async open(url: string, options: BrowserOptions = {}): Promise<PlaywrightBrowser> {
    const self = new PlaywrightBrowser();
    // '' means Playwright's bundled Chromium; anything else, including the default, is an installed browser.
    const channel = options.channel ?? 'chrome';
    self.allowDestructive = options.allowDestructive ?? false;
    try {
      const at = options.window;
      self.browser = await chromium.launch({
        channel: channel || undefined,
        headless: options.headless ?? false,
        args: at ? [`--window-position=${at.x},${at.y}`, `--window-size=${at.width},${at.height}`] : [],
      });
    } catch (error) {
      // A launch error names a browser binary, never a URL, so it is safe to show.
      throw new Error(`Could not launch ${channel || 'bundled Chromium'}: ${(error as Error).message.split('\n')[0]}`);
    }
    try {
      // A fresh context per run: no cookies or sign-ins from the person's own browser profile.
      // With a placed window the page follows the window's size; otherwise a fixed, roomy viewport.
      self.context = await self.browser.newContext({ viewport: options.window ? null : { width: 1280, height: 900 } });
      self.context.on('request', (request) => request.isNavigationRequest() && self.navigating.add(request));
      self.context.on('requestfinished', (request) => self.navigating.delete(request));
      self.context.on('requestfailed', (request) => self.navigating.delete(request));
      self.context.on('dialog', (dialog) => {
        const message = dialog.message().replace(/\s+/g, ' ').slice(0, 400);
        // Accepting is what completes the action the agent chose. The exception is a warning of permanent data
        // loss: that is cancelled, and the run stops for a human.
        if (dialog.type() !== 'alert' && !self.allowDestructive && DESTRUCTIVE.test(message)) {
          self.blockedDialog = message;
          return void dialog.dismiss().catch(() => undefined);
        }
        self.dialogs.push(`Browser ${dialog.type()} dialog, accepted: "${message}"`);
        return void dialog.accept().catch(() => undefined);
      });
      self.page = await self.context.newPage();
      // Flow Builder and some Setup links open a new tab. Follow it; return when it closes.
      self.context.on('page', (page) => {
        self.page = page;
        page.on('close', () => {
          const open = self.context.pages();
          if (open.length) self.page = open[open.length - 1];
        });
      });
      await self.page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      if (options.startPath && !self.page.url().includes(options.startPath)) {
        await self.page.goto(new URL(options.startPath, self.page.url()).href, { waitUntil: 'load', timeout: 60_000 });
      }
    } catch (error) {
      await self.close();
      // A navigation error can echo the URL, and a frontdoor URL carries a session.
      throw new Error(`Could not open the org: ${error instanceof errors.TimeoutError ? 'navigation timed out' : 'navigation failed'}`);
    }
    return self;
  }

  /**
   * A start path can be wrong: a planner guessed it, or a Setup node was renamed. Such a page renders almost
   * nothing, and Jev then types into the only box it can see. If the page is that empty, start from `fallback`
   * instead, where Quick Find can find the way. Returns true when it fell back.
   */
  async ensureRendered(fallback: string): Promise<boolean> {
    // Patient: a page that was just opened. A pure-Lightning Setup page (Density, Object Manager) draws its
    // content a second or two after its sidebar has stopped changing.
    const page = await this.observe(15_000, true);
    if (page.actions.length > 12 || this.page.url().includes(fallback)) return false;
    await this.page.goto(new URL(fallback, this.page.url()).href, { waitUntil: 'load', timeout: 60_000 }).catch(() => undefined);
    return true;
  }

  /** Open a same-org path in the current tab. */
  async goto(path: string): Promise<void> {
    await this.page.goto(new URL(path, this.page.url()).href, { waitUntil: 'load', timeout: 60_000 }).catch(() => undefined);
  }

  /** The main frame, then every child frame whose iframe element is displayed. */
  private async frames(): Promise<Frame[]> {
    const shown = [this.page.mainFrame()];
    for (const frame of this.page.frames().slice(1)) {
      try {
        if (await (await frame.frameElement()).isVisible()) shown.push(frame);
      } catch {
        continue;
      }
    }
    return shown;
  }

  private async read(): Promise<{ page: Page; refs: PlaywrightBrowser['refs']; loading: boolean }> {
    const actions: Action[] = [];
    const texts: string[] = [];
    const stats: FrameStats[] = [];
    const refs: PlaywrightBrowser['refs'] = new Map();
    const observed: { index: number; frame: Frame; title: string; found: Awaited<ReturnType<typeof readFrame>> & object }[] = [];
    const frames = await this.frames();
    const share = Math.max(1500, Math.floor(6000 / frames.length));
    let loading = false;
    for (const [index, frame] of frames.entries()) {
      let state;
      try {
        // A Classic form post reloads its iframe. Until that document is complete, what is on screen is either
        // the old form or nothing at all, and the control count of the rest of the page holds perfectly still.
        if ((await frame.evaluate(() => document.readyState)) !== 'complete') loading = true;
        state = await frame.evaluate(readFrame);
      } catch {
        if (index === 0) throw new Stale('Document is navigating');
        loading = true;
        continue;
      }
      if (!state) {
        loading = true;
        continue;
      }
      const title = state.title || frame.name() || String(index);
      if (state.text) texts.push((index ? `[frame: ${title}]\n` : '') + state.text.slice(0, share));
      stats.push({ frame: index, url: state.url, ...state.stats });
      observed.push({ index, frame, title, found: state });
    }
    // When the table overflows, the embedded page keeps its controls and the surrounding chrome gives way. The
    // Setup sidebar alone is over a hundred links; seen live, it and one long dropdown pushed the buttons the
    // step needed off the end of the table.
    const embedded = observed.filter((o) => o.index > 0).reduce((n, o) => n + o.found.actions.length, 0);
    const chrome = Math.max(0, MAX_ACTIONS - embedded);
    for (const { index, frame, title, found } of observed) {
      for (const [position, control] of found.actions.entries()) {
        if (actions.length >= MAX_ACTIONS || (index === 0 && position >= chrome)) break;
        const id = `e${actions.length + 1}`;
        refs.set(id, { frame, node: control.node });
        // actionSpace groups operations by node, so the identity must be unique across frames.
        actions.push({ ...control, id, node: `${index}:${control.node}`, label: control.label + (index ? ` (in frame: ${title})` : '') });
      }
    }
    actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
    const url = this.page.url();
    const text = [...this.dialogs, ...texts].join('\n');
    const fingerprint = createHash('sha256').update(JSON.stringify({ url, text, actions })).digest('hex');
    return { page: { url, title: await this.page.title(), text, actions, fingerprint, stats }, refs, loading };
  }

  /**
   * Lightning renders long after load, and its loading skeleton holds perfectly still. So "settled" means the
   * same URL, control count and text length on three consecutive reads, with no frame still loading and no
   * document request in flight, and a
   * near-empty page is not believed for 6 seconds.
   */
  async observe(settleMs = 12_000, patient = false): Promise<Page> {
    // A pure-Lightning page (Object Manager, Density) draws its content a second or two after its sidebar has
    // stopped changing. Seen live: a click opened the Account object, the look came too soon, five controls
    // were read, and Jev flailed. So any arrival at a new URL is watched for longer, not just the first page.
    const arrived = () => this.page.url().split('?')[0] !== this.settledUrl;
    const started = Date.now();
    let previous: string | null = null;
    let stable = 0;
    for (;;) {
      let result: Awaited<ReturnType<PlaywrightBrowser['read']>> | null = null;
      try {
        result = await this.read();
      } catch {
        result = null;
      }
      const elapsed = Date.now() - started;
      if (result) {
        const count = result.page.actions.length;
        const signature = `${result.page.url}|${count}|${result.page.text.length}`;
        stable = signature === previous && !result.loading && this.navigating.size === 0 ? stable + 1 : 0;
        previous = signature;
        const skeleton = count <= 4 && elapsed < 6000;
        // After a save, Lightning re-routes and swaps in a new iframe. For a moment there is no iframe and
        // nothing in flight, and the page looks settled with only its navigation. Give the frame time to return.
        const frames = new Set(result.page.actions.map((a) => a.node?.split(':')[0])).size - 1;
        // A Classic page opened inside Lightning (".../page?address=...") is nothing but its iframe. Seen live: the
        // Sites detail page took over 5 seconds, the sidebar alone was read as the page, and Jev clicked "Sites"
        // again, four times round. There the frame is waited for as long as the page itself.
        const classic = /\/lightning\/setup\/[^/]+\/page\?address=/.test(result.page.url);
        const vanished = frames < this.contentFrames && elapsed < (classic ? settleMs : 5000);
        const needed = patient || arrived() ? 5 : 2;
        if ((stable >= needed && !skeleton && !vanished) || elapsed > settleMs) {
          this.refs = result.refs;
          this.contentFrames = frames;
          this.settledUrl = this.page.url().split('?')[0];
          // Each dialog is reported in exactly one observation: the one that follows it.
          this.dialogs = [];
          if (this.blockedDialog) result.page.blockedDialog = this.blockedDialog;
          return result.page;
        }
      } else {
        previous = null;
        stable = 0;
        if (elapsed > settleMs) throw new Stale('Page did not settle');
      }
      await this.page.waitForTimeout(400);
    }
  }

  private async resolve(action: Action): Promise<ElementHandle<Element>> {
    const ref = this.refs.get(action.id);
    if (!ref) throw new Stale('Target was not in the last observation');
    try {
      const handle = (await ref.frame.evaluateHandle((id) => (window as any).__sfAutopilot?.nodes.get(id) ?? null, ref.node)).asElement();
      if (!handle || !(await handle.evaluate((e) => e.isConnected))) throw new Stale('Target is no longer in the page');
      return handle as ElementHandle<Element>;
    } catch (error) {
      if (error instanceof Stale) throw error;
      throw new Stale('Target frame changed');
    }
  }

  /** Returns how the input was delivered. Every Stale is thrown before any input is sent. */
  async act(action: Action, text?: string): Promise<string> {
    if (action.kind === 'wait') {
      await this.page.waitForTimeout(1000);
      return 'wait';
    }
    const handle = await this.resolve(action);
    try {
      if (action.kind === 'fill' && action.options) {
        await handle.selectOption({ label: text ?? '' }, { timeout: 5000 });
        await this.quiet(action);
        return 'select';
      }
      if (action.kind === 'fill') {
        // fill() sets the value and fires only `input`. Lightning's Quick Find, lookups and other autocompletes
        // filter on key events, so after fill() the box holds the text and nothing happens. Clear, then type.
        await handle.fill('', { timeout: 5000 });
        await handle.type(text ?? '', { delay: 15, timeout: 15_000 });
        // A list's own search box ("Search this list...") searches only on Enter. Seen live: "AI User" sat in the
        // Users list search, nothing was filtered, and Jev gave up. Only a search box, never a form field, where
        // Enter could submit the form; and not Quick Find, which filters as you type.
        if (action.role === 'searchbox' && !/^Quick Find\b/.test(action.label)) {
          // The text is already in: a failure here is after input, so it must stop the run, never read as Stale.
          await handle.press('Enter', { timeout: 5000 }).catch((error: Error) => {
            throw new Error(`Enter after typing failed: ${error.message}`);
          });
          await this.quiet(action);
          return 'type+enter';
        }
        await this.quiet(action);
        return 'type';
      }
      if (action.kind === 'select') {
        await handle.selectOption({ index: action.option_index }, { timeout: 5000 });
        return 'select';
      }
    } catch (error) {
      if (error instanceof errors.TimeoutError) throw new Stale('Target cannot take input');
      throw error;
    }
    // trial runs Playwright's visible/stable/enabled/unobscured checks without clicking, so the label
    // fallback below can never follow a click that was already delivered.
    try {
      await handle.click({ trial: true, timeout: 3000 });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      const label = (await handle.evaluateHandle((e) => (e as HTMLInputElement).labels?.[0] ?? null)).asElement();
      if (!label) throw new Stale('Target is covered or not clickable');
      try {
        await label.click({ trial: true, timeout: 3000 });
      } catch {
        throw new Stale('Target and its label are covered');
      }
      await this.dispatch(label);
      await this.quiet(action);
      return 'label-click';
    }
    await this.dispatch(handle);
    await this.quiet(action);
    return 'click';
  }

  /**
   * The real click. Playwright refuses, before sending any input, when the element detached between the trial
   * and now (seen live: a Classic iframe reloading). That refusal is Stale. Any other failure is ambiguous about
   * whether input was delivered, so it propagates and stops the run.
   */
  private async dispatch(target: ElementHandle<Element>): Promise<void> {
    try {
      await target.click({ timeout: 10_000 });
    } catch (error) {
      if (/not attached to the DOM/i.test((error as Error).message)) throw new Stale('Target detached before input');
      throw error;
    }
  }

  /** A form post issues its document request a beat after the click. Wait that beat so observe() can see it. */
  private async quiet(_action: Action): Promise<void> {
    await this.page.waitForTimeout(250);
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }
}
