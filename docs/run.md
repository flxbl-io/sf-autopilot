# Doing a step: `run`

[← README](../README.md)

When the step has not been done yet, the agent does it in the browser, and Salesforce's audit trail judges the
result ([audit.md](audit.md#the-same-check-after-a-run)).

- [Three parts](#three-parts)
- [Working up to a real run](#working-up-to-a-real-run)
- [Flags, exit codes, traces](#flags-exit-codes-traces)
- [Guards](#guards)
- [What Salesforce's UI needed](#what-salesforces-ui-needed)
- [The code](#the-code)

## Three parts

Each does only what it is good at.

```text
manual step ──► recipe, or ──► ┌─────────────── browser loop ────────────────┐ ──► Setup Audit Trail:
                LLM plans      │ Playwright reads page → indexed controls    │     did Salesforce itself
                               │ Jev chooses operation + control (1 request) │     record the change?
                               │ LLM writes text, only for TYPE_TEXT         │     Jev reads the record
                               │ Playwright executes → observe again         │     and says yes or no
                               │ LLM reviews the page after each click       │
                               └─────────────────────────────────────────────┘
```

| Part | Job | Why this one |
| --- | --- | --- |
| **LLM** (any OpenAI-compatible endpoint; Claude Sonnet by default) | Turns the human step into a plan: where to start, a precise goal, ordered UI actions, what "done" looks like. Writes the value when a field needs typing. Says so when a step is not a browser step. Reviews the page after every click. When the run is stuck, suggests what the current page offers to try. | Understanding a vague instruction, and judging whether a page proves something, are reasoning tasks. |
| **[Jev](https://docs.typesafe.ai/introduction)** (TypeSafe) | Chooses every action: which operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `UPLOAD_FILE`, `WAIT`, `SCROLL`, `DONE`, `BLOCKED`) and which observed control. One request returns both. | Not a language model: a [System One model](https://docs.typesafe.ai/concepts/system-one) that returns typed decisions with calibrated probabilities instead of text. It can only pick from controls that exist on the page. |
| **Playwright** | Reads the DOM into an indexed control table and executes the chosen action. | Pierces open shadow roots, handles cross-origin iframes, scrolls targets into view, and hit-tests before clicking. |

Jev never produces a selector, a coordinate, or JavaScript. It has no way to: its answer is an index into a
table this code built from the live page.

The loop and the Jev request shape are a TypeScript port of
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). New here: the planner, the
provider-neutral LLM client, the Playwright layer, a DOM reader that copes with Salesforce, recipes, and the
audit check.

## Working up to a real run

The first two steps cost almost nothing.

```bash
# 1. Is the planner sensible? One LLM call. No browser, no org.
sf-autopilot plan --step "Enable 'Let users relate a contact to multiple accounts'."

# 2. Can it see the page? No model calls at all.
sf-autopilot diagnose --org my-sandbox

# 3. Run it. --confirm shows the plan, then pauses before every action. Use it until you trust it.
sf-autopilot run --org my-sandbox --confirm --step-file step.md
```

A run looks like this:

```text
Plan (recipe:unlocked-package-remove-component, 0 ms)
 1. CLICK     sfpowerscripts-artifact (in frame: Installed Packages ~ Salesforce)               p=0.99 conf=0.86
 2. CLICK     View Components (in frame: Package Details: sfpowerscripts-artifact ~ Salesforce) p=0.97 conf=0.91
    reviewer: not yet - The Commit Id custom field still appears in the package's components table.
 3. CLICK     Remove (row: Remove Commit Id Sfpowerscripts Artifact 2 Custom Field) (in frame…) p=0.99 conf=0.91
```

And a step the planner refuses, because no amount of clicking does it:

```text
$ sf-autopilot run --org my-sandbox --step "Load the 2M legacy accounts from accounts.csv with Data Loader."
Not a browser step: This step requires the Data Loader desktop application to load an external CSV file,
which is outside the browser-based Salesforce Setup UI the agent can access.
```

More real runs: [samples.md](samples.md).

## Flags, exit codes, traces

| Flag | Meaning |
| --- | --- |
| `--step`, `--step-file` | The manual step, as a person wrote it. |
| `--file`, `--files` | Files the step may upload. `--file` names one (repeatable). `--files <dir>` offers the files under `<dir>` that the step names, by path or name; repeatable, nearest folder first, e.g. the runbook's own folder then the repository. Without either, no upload is ever offered. |
| `--confirm` | Show the plan, then pause before every action. |
| `--no-recipes` | Plan from scratch even when a [recipe](recipes.md) matches. `--candidates` lets an untested recipe steer. |
| `--raw` | Skip the planner and give Jev the step exactly as written. Useful for seeing what the planner is worth. |
| `--no-verify` | Accept Jev's `DONE` unreviewed. |
| `--no-ideas` | When stuck, do not ask the LLM what the current page offers to try. |
| `--allow-destructive` | Continue past a page that warns of permanent data loss. |
| `--start-path`, `--max-actions` | Where to begin; how many actions at most (default: 6 per planned step, at least 25, at most 60). |
| `--headless`, `--window x,y,w,h`, `--channel`, `--keep-open` | The browser. |

Exit codes: `0` done, `2` stopped, blocked or unverified, `3` the planner judged it not a browser step.

Each run writes `artifacts/<timestamp>/` (git-ignored): `trace.json` with the plan and, for every decision, the
operation, target, top-3 target probabilities, confidence and latency; a screenshot per action; and
`last_observation.json`, the final control table.

## Guards

**Where it may act**

- Only on `*.salesforce.com`, `*.force.com`, `*.salesforce-setup.com`, `*.visualforce.com`. Leaving stops the run.
- A start path written by the planner is accepted only as a same-org `/lightning/...` path.
- 25 actions at most. Three actions in a row that change nothing stop the run.

**Destructive changes**

- A page that warns of permanent data loss ("permanently deleted", "cannot be undone", ...) stops the run before
  any input. That is where a human belongs. `--allow-destructive` overrides it. The match is deliberately broad:
  a false positive only hands the step to a person.
- A native dialog that warns of permanent data loss is cancelled, and the run stops. Any other `confirm()` is
  accepted, since accepting is what completes the click the agent chose.

**Knowing when to stop**

- The reviewer decides when the run is over, not Jev. After every click that changes the page, the LLM checks
  the page against the done-condition and ends the run the moment it holds, so a finished step cannot be
  overshot. A `DONE` from Jev is checked the same way; two rejected `DONE`s end the run as `unverified`.
- Flipping the toggle it has only just flipped is refused. On a sandbox Jev unticked one checkbox, ticked it
  again, and so on 24 times, never clicking Save. The repeat is now refused and Jev is told why; a second try
  ends the run.
- One `BLOCKED` is not believed. The loop waits two seconds and looks again; only two in a row end the run.
- A third click in a row on one control, or the same text typed into one field a third time, is refused; a second
  refusal ends the run. Seen live: "Timeline Settings" clicked twelve times, "Flows" typed into Quick Find 25 times,
  each redrawing the page so the no-progress stop never fired. Paging (Next, Show More) is exempt.
- One Save pressed a third time ends the run for a human: a picklist edit was saved four times over because the
  reviewer wanted proof that page never shows.
- A target that stays covered (an open dialog over "Activation...") is explained to Jev after two refusals and
  ends the run after five, instead of forty requests.
- `SCROLL` loads more rows of a long list; twenty per run at most.
- When the page is about one record (an id in its URL or a frame's), the reviewer is also given that record as the
  org holds it, read with SOQL. Seen live: a loan product's Max Term was set to 1000 and saved on a managed-package
  page that never showed it; the run went on until a guard stopped it. The saved record is the evidence.
- When the run is stuck (a `BLOCKED`, a refused repeat, a covered target, two unsure decisions in a row) the LLM
  looks at the page it is on and suggests up to three things worth trying, naming controls that are there. Jev
  reads them as suggestions and still chooses from the table. Nothing about where Salesforce keeps a button is
  written in advance, so a release that moves one changes the ideas instead of breaking a hint. Six per run at most.

**Clicking safely**

- A target that is covered, removed or disabled is rejected *before* any input is sent, so choosing again can
  never repeat a click. A failure *after* input stops the run instead of retrying.
- Malformed model output of any kind executes nothing.

**Secrets**

- Password, file and hidden inputs are never read. A fresh browser context per run: none of your own cookies.
- A file input is offered by its label only. The file to attach comes from the operator (`--file`, `--files`); a
  model sees file names, picks one from that list when there are several, and code maps the name to the path.
  One file is never attached twice to one control in a run.
- The sign-in URL carries a session. It is never printed, logged, or written to a trace.
- Signing in is `sf org open --url-only`; no password is ever handled.

## What Salesforce's UI needed

| Obstacle | Handled by |
| --- | --- |
| Lightning components in shadow roots | the reader walks open shadow roots with a `TreeWalker` |
| Classic Setup pages embedded as cross-origin iframes | one snapshot per Playwright frame, merged into one table |
| Panes that scroll inside the page | offscreen controls stay in the table; Playwright scrolls the target into view |
| Lightning rendering long after `load` | `observe()` reads until the control count holds still |
| SLDS toggles (the real input is clipped to 1px) | clicked through their label |
| A Classic form post: the old form stays on screen, `readyState` stays `complete`, network idle has already fired | in-flight document requests are tracked; a page is not settled while one is pending |
| After a save, Lightning re-routes and swaps in a new iframe; briefly there is none | a content frame that vanished is waited for |
| Saved state shown as a **disabled** checkbox, which is not a control | disabled controls are reported as read-only facts in the page text, never as targets |
| Quick Find, lookups and other autocompletes filter on key events; setting the value does nothing | text is typed with real key events |
| Classic "Remove" / "Del" links raise a native `confirm()`, which is not in the DOM and which Playwright cancels silently | dialogs are answered, and what they said is shown to the models in the next observation |
| A table has one "Remove" per row, all labelled alike | a label shared by several controls gains the text of its own row |
| Classic keeps a field's label in the next table cell, with no `<label for>` | an unnamed `<select>` takes the cell to its left |
| One dropdown with hundreds of options (Default Locale) fills the whole control table | a long dropdown is one target; the LLM names the option, which must match one verbatim |
| The Setup sidebar is over a hundred links and crowds out the embedded page | when the table overflows, the embedded page keeps its controls and the sidebar gives way |
| A page listing every object (Sharing Settings) is too large for Jev: `max_tokens_exceeded` | retried with the 120, then 60, controls sharing most words with the goal |
| Some Classic pages are always an edit form, and Save lands on Setup Home | the reviewer is told what the agent just did and whether the session is fresh; the page is reopened after a save-like click |
| A start path that does not render leaves only the global search box | the run starts from Setup Home instead |
| An `<iframe tabindex="0">` looks like a button | frames are never controls |
| The Setup tree lists every node twice (row + link) | a row wrapping a real link is dropped; the table shrank by about a third |
| Flow Builder and others opening a new tab | the newest tab is followed |
| Lightning's synthetic shadow throws on `ShadowRoot.getElementById`; one `aria-labelledby` on a record list failed every observation of the page | the lookup falls back to `querySelector`, then the document |
| LWC options and buttons draw their words inside their own shadow root, so App Launcher results all read as "option" | an element's name includes its shadow root's text (not a datatable cell's, which would flood the table) |
| A datatable's read-only checkbox cells read as forty lines of "true: checked" | facts named only by a value are dropped |
| Long Lightning lists (Flows) draw their first rows and load the rest on scroll | `SCROLL` scrolls the longest scrollable list, or the page |
| SLDS file selectors clip the real `<input type=file>` to 1px under an "Upload Files" label | the input is offered through whatever is drawn over it, and attached with `setInputFiles` |

Out of reach: closed shadow roots, canvas, drag and drop, keyboard-only widgets. The planner can
name a Setup page that does not exist; the agent then falls back to Quick Find.

## The code

```bash
npm test
```

Offline: no model calls and no network. Only the HTTP layer is faked, so the real `choose()` / `actionSpace()` /
`validateChoice()` run against Playwright observations of a fixture with nested shadow roots, an iframe, an
SLDS-style toggle, a native select and an offscreen control. The browser tests skip only if Chrome is genuinely
missing; any other setup failure fails.

| File | Job |
| --- | --- |
| [src/cli.ts](../src/cli.ts) | the commands |
| [src/run.ts](../src/run.ts) | the loop |
| [src/jev.ts](../src/jev.ts) | the operation + target request, and validation of its answer |
| [src/planner.ts](../src/planner.ts) | human step → plan |
| [src/verify.ts](../src/verify.ts) | the page reviewer |
| [src/audit.ts](../src/audit.ts), [src/check.ts](../src/check.ts) | reading the Setup Audit Trail; the `audit` command |
| [src/recipes.ts](../src/recipes.ts), [src/trial.ts](../src/trial.ts) | the recipe library and its trials |
| [src/llm.ts](../src/llm.ts) | OpenAI-compatible client with tolerant JSON parsing |
| [src/text.ts](../src/text.ts) | field values for `TYPE_TEXT` |
| [src/snapshot.ts](../src/snapshot.ts) | the in-page DOM reader |
| [src/browser.ts](../src/browser.ts) | Playwright: observe every frame, execute safely |
| [src/guards.ts](../src/guards.ts) | allowed hosts, destructive wording |
| [src/org.ts](../src/org.ts) | org alias → signed-in URL |
| [src/prompts.ts](../src/prompts.ts) | every instruction any model sees |
