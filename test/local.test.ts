/**
 * Everything around the model calls, end to end, in a real browser. No model calls, no Salesforce, no network.
 *
 * Only the HTTP layer is faked, so the real choose() / actionSpace() / validateChoice() run against Playwright
 * observations of a page with nested open shadow roots, an iframe, an SLDS-style clipped toggle, a native
 * select, and an offscreen control.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PlaywrightBrowser, Stale } from '../src/browser.js';
import { choose } from '../src/jev.js';
import { run } from '../src/run.js';
import type { Post } from '../src/types.js';

const escape = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ZONES = Array.from({ length: 40 }, (_, i) => `<option>Zone ${i}</option>`).join('');
const FRAME = `<style>
.toggle input{position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden;margin:-1px;border:0}
.faux{display:inline-block;width:48px;height:24px;background:#888;border-radius:12px;vertical-align:middle}
</style><title>Process Automation Settings</title><form onsubmit="return false">
<label class="toggle"><input id="t" type="checkbox"><span class="faux"></span> Enable Order Follow Up</label>
<select aria-label="Run as"><option>User</option><option>System</option></select>
<select aria-label="Time Zone">${ZONES}</select>
<table><tr><td>Run As</td><td><input type="text"></td></tr></table>
<img alt="Checked" width="21" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=">
<input type="password" value="never expose this" aria-label="Secret">
<label for="ro">Shared contacts</label><input id="ro" type="checkbox" checked disabled>
<button type="button" onclick="window.saved={enabled:document.querySelector('#t').checked,
  runAs:document.querySelector('select').value}">Save</button></form>`;

const PAGE = `<!doctype html><title>Setup fixture</title>
<label>Quick Find <input id="qf" type="search"></label>
<flow-row></flow-row>
<table><tr><td><a href="#r1">Remove</a></td><td>Tag</td><td>Custom Field</td></tr><tr><td><a href="#r2">Remove</a></td><td>Version</td><td>Custom Field</td></tr></table>
<div role="grid"><div role="row"><div role="gridcell" tabindex="0"><cell-text></cell-text></div><div role="gridcell" tabindex="-1"><button>Show actions</button></div></div></div>
<input type="search" placeholder="Search this list..." onkeydown="if(event.key==='Enter')window.searched=this.value">
<div class="rolodex"><a href="#A">A</a> <a href="#B">B</a> <a href="#C">C</a> <a href="#D">D</a> <a href="#E">E</a> <a href="#F">F</a> <a href="#G">G</a> <a href="#H">H</a> <a href="#I">I</a> <a href="#J">J</a> <a href="#K">K</a> <a href="#L">L</a> <a href="#M">M</a> <a href="#N">N</a> <a href="#O">O</a> <a href="#P">P</a> <a href="#Q">Q</a> <a href="#R">R</a> <a href="#S">S</a> <a href="#T">T</a> <a href="#U">U</a> <a href="#V">V</a> <a href="#W">W</a> <a href="#X">X</a> <a href="#Y">Y</a> <a href="#Z">Z</a> <a href="#other">Other</a> <a href="#all">All</a></div>
<ul role="tree"><li role="treeitem"><a href="#users">Users</a></li><li role="treeitem" tabindex="0">Leaf node</li></ul>
<iframe title="Process Automation Settings" tabindex="0" width="640" height="200" srcdoc="${escape(FRAME)}"></iframe>
<div style="height:3000px"></div>
<button id="far" onclick="window.farClicks=(window.farClicks||0)+1">Far below</button>
<script>
customElements.define('flow-actions', class extends HTMLElement { connectedCallback() {
  const root=this.attachShadow({mode:'open'}); root.innerHTML='<button>Activate</button>';
  root.querySelector('button').onclick=()=>window.activated=(window.activated||0)+1; } });
customElements.define('cell-text', class extends HTMLElement { connectedCallback() {
  this.attachShadow({mode:'open'}).innerHTML='<span>Partner API</span>'; } });
customElements.define('flow-row', class extends HTMLElement { connectedCallback() {
  this.attachShadow({mode:'open'}).innerHTML='<span>Order Follow Up</span><flow-actions></flow-actions>'; } });
</script>`;

const SCRIPT: [string, string | null][] = [
  ['TYPE_TEXT', 'Quick Find'],
  ['CLICK', 'Activate'],
  ['CLICK', 'Enable Order Follow Up'],
  ['SELECT', 'Run as → System'],
  ['CLICK', 'Save'],
  ['CLICK', 'Far below'],
  ['DONE', null],
];

let folder: string;
let browser: PlaywrightBrowser | undefined;
let unavailable: string | undefined;

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'sf-autopilot-'));
  await writeFile(join(folder, 'fixture.html'), PAGE);
  try {
    browser = await PlaywrightBrowser.open(pathToFileURL(join(folder, 'fixture.html')).href, { headless: true });
  } catch (error) {
    // Only a missing browser skips. Any other setup failure is a real failure and must not hide as a skip.
    if (!(error as Error).message.startsWith('Could not launch')) throw error;
    unavailable = (error as Error).message;
  }
});

after(async () => {
  await browser?.close();
  await rm(folder, { recursive: true, force: true });
});

test('the loop drives shadow DOM, an iframe, a clipped toggle, a select and an offscreen control', async (t) => {
  if (!browser) return t.skip(unavailable);
  const requests: unknown[] = [];
  const typesafe: Post = async (_url, _key, body: any) => {
    const [operation, needle] = SCRIPT[requests.length];
    requests.push(body);
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries<any>(body.questions)) {
      const ids = Object.keys(question.criteria);
      const pick = name === 'operation'
        ? operation
        : ids.find((id) => needle && question.criteria[id].element.includes(needle)) ?? ids[0];
      answers[name] = { choice: pick, confidence: 1, probabilities: Object.fromEntries(ids.map((id) => [id, id === pick ? 1 : 0])) };
    }
    return { model: 'offline', answers, usage: { input_tokens: 100, output_tokens: 5 } };
  };

  const result = await run(browser, 'Activate Order Follow Up and enable it as System', {
    allowedHosts: null,
    output: folder,
    choose: (page, goal, history) => choose(page, goal, history, { apiKey: 'offline', post: typesafe }),
    text: async () => ({ text: 'Flows', model: 'offline', latencyMs: 0, usage: {} }),
  });

  assert.equal(result.status, 'done');
  assert.equal(result.actions, 6);
  assert.equal(requests.length, 7, 'one Jev request per decision');
  assert.equal(result.inputTokens, 700);

  const page = browser.page;
  assert.equal(await page.evaluate(() => (document.querySelector('#qf') as HTMLInputElement).value), 'Flows');
  assert.equal(result.steps[0].delivered, 'type');
  assert.equal(await page.evaluate(() => (window as any).activated), 1, 'button two open shadow roots deep');
  assert.deepEqual(await page.frames()[1].evaluate(() => (window as any).saved), { enabled: true, runAs: 'System' });
  assert.equal(result.steps[2].delivered, 'label-click', 'clipped toggle is clicked through its label');
  assert.equal(result.steps[3].delivered, 'select');
  assert.equal(await page.evaluate(() => (window as any).farClicks), 1, 'offscreen control scrolled into view');

  const observed = JSON.parse(await readFile(join(folder, 'last_observation.json'), 'utf8'));
  assert.equal(observed.stats[0].open_shadow_roots, 3);
  assert.ok(observed.stats[0].walked > observed.stats[0].query_selector_all, 'shadow controls were reached');
  assert.ok(!JSON.stringify(observed).includes('never expose this'), 'password values never leave the page');
  assert.match(observed.text, /\[Checked\]/, 'state drawn as an image (Classic Setup) is readable');
  const labels: string[] = observed.actions.map((a: any) => `${a.role}:${a.label}`);
  assert.match(observed.text, /Shared contacts: checked \(read-only\)/, 'a disabled control still reports its saved state');
  assert.ok(!labels.some((l) => l.includes('Shared contacts')), 'but is never offered as a target');
  assert.ok(!labels.includes('button:Process Automation Settings'), 'a frame is a container, never a control');
  assert.ok(labels.includes('link:Users') && !labels.includes('treeitem:Users'), 'a row wrapping a link is listed once');
  assert.ok(labels.includes('treeitem:Leaf node'), 'a row with no inner control is still reachable');
  assert.ok(labels.includes('link:Remove (row: Remove Tag Custom Field)') && labels.includes('link:Remove (row: Remove Version Custom Field)'),
    `identical labels carry their row, got: ${labels.filter((l) => l.includes('Remove')).join(' ; ')}`);
  assert.ok(labels.includes('button:Activate'), 'a label that is already unique is left alone');
  assert.ok(labels.some((l) => l.startsWith('textbox:Run As')), 'an unlabelled Classic text field takes the cell to its left');
  const zone = observed.actions.filter((a: any) => a.label.startsWith('Time Zone'));
  assert.equal(zone.length, 1, 'a 40-option dropdown is one target, not 40');
  assert.deepEqual([zone[0].kind, zone[0].options.length], ['fill', 40]);
  assert.ok(existsSync(join(folder, 'trace.json')) && existsSync(join(folder, 'final.png')));
});

test('a datatable cell with no name of its own is not a target, the real control in its row is', async (t) => {
  if (!browser) return t.skip(unavailable);
  const page = await browser.observe();
  const labels = page.actions.map((a) => `${a.role}:${a.label}`);
  assert.ok(!labels.some((l) => l.startsWith('gridcell:')), `unnamed cells were offered: ${labels.filter((l) => l.startsWith('gridcell')).join(' ; ')}`);
  assert.ok(labels.includes('button:Show actions'));
});

test('an A-Z row above a Classic list says what its letters do', async (t) => {
  if (!browser) return t.skip(unavailable);
  const labels = (await browser.observe()).actions.map((a) => a.label);
  assert.ok(labels.includes('L (list filter: show only records whose name starts with L)'), labels.filter((l) => /^L\b/.test(l)).join(' ; '));
  assert.ok(labels.includes('All (list filter: show every record)'));
});

test("a list's search box is submitted with Enter; Quick Find is not", async (t) => {
  if (!browser) return t.skip(unavailable);
  const page = await browser.observe();
  const list = page.actions.find((a) => a.kind === 'fill' && a.label === 'Search this list...')!;
  assert.equal(await browser.act(list, 'AI User'), 'type+enter');
  assert.equal(await browser.page.evaluate(() => (window as any).searched), 'AI User');
  const quickFind = (await browser.observe()).actions.find((a) => a.kind === 'fill' && a.label === 'Quick Find')!;
  assert.equal(await browser.act(quickFind, 'Users'), 'type');
});

test('a covered or removed target is rejected before any input is sent', async (t) => {
  if (!browser) return t.skip(unavailable);
  const observed = await browser.observe();
  const far = observed.actions.find((a) => a.label === 'Far below')!;
  await browser.page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(cover);
  });
  await assert.rejects(browser.act(far), Stale);
  assert.equal(await browser.page.evaluate(() => (window as any).farClicks), 1);
  await browser.page.evaluate(() => { document.querySelector('#cover')!.remove(); document.querySelector('#far')!.remove(); });
  await assert.rejects(browser.act(far), Stale);
});

test('a run stops when the page leaves the org', async (t) => {
  if (!browser) return t.skip(unavailable);
  const result = await run(browser, 'anything', { choose: async () => assert.fail('must not ask Jev off-org') });
  assert.match(result.status, /^stopped: left the org/);
  assert.equal(result.jevRequests, 0);
});

test('a loading skeleton that holds still is not mistaken for the page', async (t) => {
  if (!browser) return t.skip(unavailable);
  const late = join(folder, 'late.html');
  await writeFile(late, `<!doctype html><title>Late</title><button>Skeleton</button><script>
    setTimeout(() => { for (let i = 0; i < 10; i++) document.body.append(Object.assign(document.createElement('button'), {textContent: 'Real ' + i})); }, 1500);
  </script>`);
  const slow = await PlaywrightBrowser.open(pathToFileURL(late).href, { headless: true });
  try {
    const started = Date.now();
    const observed = await slow.observe();
    assert.equal(observed.actions.filter((a) => a.label.startsWith('Real')).length, 10, 'waited for the real controls');
    assert.ok(Date.now() - started < 6000, 'and returned as soon as they held still, not at the deadline');
  } finally {
    await slow.close();
  }
});

test('after a form post reloads an iframe, the next observation is the saved page, not the old form or a blank', async (t) => {
  if (!browser) return t.skip(unavailable);
  // Reproduces a Classic Setup page: Save posts the iframe, and the response is slow. Seen live, the agent
  // observed first the stale edit form and then a page with the iframe still blank; both looked "settled".
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/') return response.end('<title>Setup</title>' + '<button>Nav</button>'.repeat(6) + '<iframe src="/form" width="600" height="200"></iframe>');
    if (request.url === '/form') return response.end('<title>Settings</title><form action="/saved"><input type="checkbox" aria-label="Flag" checked><button>Save</button></form>');
    return void setTimeout(() => response.end('<title>Settings</title><p>Saved.</p><button>Edit</button>'), 1500);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const posting = await PlaywrightBrowser.open(`http://127.0.0.1:${port}/`, { headless: true });
  try {
    const before = await posting.observe();
    const save = before.actions.find((a) => a.label.startsWith('Save'))!;
    assert.equal(await posting.act(save), 'click');
    const labels = (await posting.observe()).actions.map((a) => a.label);
    assert.ok(labels.some((l) => l.startsWith('Edit')), `saved page observed, got: ${labels.join(', ')}`);
    assert.ok(!labels.some((l) => l.startsWith('Save')), 'the stale edit form is gone');
  } finally {
    await posting.close();
    server.close();
  }
});

test('a content frame that vanishes and returns is waited for, as when Lightning re-routes after a save', async (t) => {
  if (!browser) return t.skip(unavailable);
  const file = join(folder, 'swap.html');
  await writeFile(file, `<!doctype html><title>Setup</title>${'<button>Nav</button>'.repeat(6)}
    <button id="go" onclick="const f=document.querySelector('iframe'); f.remove();
      setTimeout(()=>{const n=document.createElement('iframe'); n.width=600; n.height=200;
      n.srcdoc='<title>Settings</title><p>Saved.</p><button>Edit</button>'; document.body.append(n)}, 2000)">Save</button>
    <iframe width="600" height="200" srcdoc="<title>Settings</title><button>Apply</button>"></iframe>`);
  const swapping = await PlaywrightBrowser.open(pathToFileURL(file).href, { headless: true });
  try {
    const before = await swapping.observe();
    assert.ok(before.actions.some((a) => a.label.startsWith('Apply')));
    await swapping.act(before.actions.find((a) => a.label === 'Save')!);
    const labels = (await swapping.observe()).actions.map((a) => a.label);
    assert.ok(labels.some((l) => l.startsWith('Edit')), `the returning frame was waited for, got: ${labels.join(', ')}`);
  } finally {
    await swapping.close();
  }
});

test('text is typed with real key events, and native dialogs are answered and reported', async (t) => {
  if (!browser) return t.skip(unavailable);
  const file = join(folder, 'keys.html');
  await writeFile(file, `<!doctype html><title>Setup</title>${'<button>Nav</button>'.repeat(6)}
    <label>Quick Find <input id="qf" type="search"></label><ul id="results"></ul>
    <button onclick="if (confirm('Remove this component from the package?')) window.removed = true">Remove</button>
    <button onclick="if (confirm('All related data will be permanently deleted.')) window.wiped = true">Wipe</button>
    <script>// Filters on keyup, like Lightning's Quick Find: a value set without key events does nothing.
      qf.addEventListener('keyup', () => results.innerHTML = qf.value ? '<li><a href="#d">' + qf.value + ' page</a></li>' : '');</script>`);
  const typing = await PlaywrightBrowser.open(pathToFileURL(file).href, { headless: true });
  try {
    let page = await typing.observe();
    assert.equal(await typing.act(page.actions.find((a) => a.kind === 'fill')!, 'Deliverability'), 'type');
    page = await typing.observe();
    assert.ok(page.actions.some((a) => a.label === 'Deliverability page'), 'the keyup-driven result appeared');

    await typing.act(page.actions.find((a) => a.label === 'Remove')!);
    page = await typing.observe();
    assert.equal(await typing.page.evaluate(() => (window as any).removed), true, 'an ordinary confirm is accepted');
    assert.match(page.text, /Browser confirm dialog, accepted: "Remove this component from the package\?"/);
    assert.equal(page.blockedDialog, undefined);
    assert.doesNotMatch((await typing.observe()).text, /Browser confirm dialog/, 'and is reported once');

    await typing.act(page.actions.find((a) => a.label === 'Wipe')!);
    page = await typing.observe();
    assert.equal(await typing.page.evaluate(() => (window as any).wiped), undefined, 'a data-loss confirm is cancelled');
    assert.match(page.blockedDialog ?? '', /permanently deleted/);
  } finally {
    await typing.close();
  }
});

test('a long dropdown is chosen by naming one of its options, and nothing else is accepted', async (t) => {
  if (!browser) return t.skip(unavailable);
  const file = join(folder, 'zones.html');
  await writeFile(file, `<!doctype html><title>Company</title>${'<button>Nav</button>'.repeat(6)}
    <label>Default Time Zone <select id="tz">${Array.from({ length: 30 }, (_, i) => `<option>(GMT+${i}) Zone ${i}</option>`).join('')}</select></label>`);
  const zones = await PlaywrightBrowser.open(pathToFileURL(file).href, { headless: true });
  try {
    const dropdown = (await zones.observe()).actions.find((a) => a.options)!;
    assert.match(dropdown.label, /Default Time Zone \(dropdown, 30 options\)/);
    assert.equal(await zones.act(dropdown, '(GMT+10) Zone 10'), 'select');
    assert.equal(await zones.page.evaluate(() => (document.querySelector('#tz') as HTMLSelectElement).selectedOptions[0].label), '(GMT+10) Zone 10');
  } finally {
    await zones.close();
  }
});
