# sf-autopilot

> **Experimental.** For the Salesforce Setup steps that have no API: **prove** one was done, or **do** it.

https://github.com/user-attachments/assets/58c25d2f-cead-4454-bc1f-97f9e2457a7d

*90 seconds on a real scratch org: a checklist step nobody did, the audit trail saying so, the agent doing it,
the audit trail proving it. Recorded from [demo/run-then-audit.sh](demo/run-then-audit.sh); the one-time sign-in
link is masked.*

## The problem

Some deployment steps cannot be deployed: a Setup toggle with no metadata coverage, a component to release from
a package, a setting buried in a Classic page. A person does them by hand and says so. Nothing checks.

## Prove it: `audit`

Salesforce already keeps the evidence. Its Setup Audit Trail records nearly every one of these changes, and to
what value. So type what should have happened:

```bash
sf-autopilot audit --org my-sandbox "Set the fiscal year to start in April, and let admins log in as any user"
```

```text
CONFIRMED      p=0.95  Set the fiscal year to start in April
    recorded: 04:21:14  orgFiscalYearStartMonth        Changed fiscal year start month from 7 to 4
CONFIRMED      p=0.90  let admins log in as any user
    recorded: 04:36:42  overridegrantaccessenabledoff  Changed Administrators Can Log in as Any User from off to on
```

- **No browser, and it does not matter who did the work**: a person following a runbook, or an agent.
- **It reads the value, not just the setting.** Ask for October when Salesforce recorded "from 7 to 4": p=0.03.
- **It shows its proof**: the exact entry Salesforce wrote. A change that was later undone is refused.
- **A pipeline can gate on it.** Exit code `0` confirmed, `2` not confirmed. `--json` for machines.

The judge is [Jev](https://docs.typesafe.ai/introduction), and Jev is not a language model. TypeSafe describes
it as a [System One model](https://docs.typesafe.ai/concepts/system-one): its own architecture, built to be
called by code. It returns a typed decision (yes or no, one of a list) with a calibrated probability, never
prose. A gate needs exactly that: nothing to be persuaded by, only a number to put a threshold on.

More: [docs/audit.md](docs/audit.md). How far to trust it, with numbers: [docs/audit-command-evaluation.md](docs/audit-command-evaluation.md).

## Do it: `run`

When nobody has done the step yet, the agent does it in the browser:

```bash
sf-autopilot run --org my-sandbox --step "Release the custom field Tag from the unlocked package billing-core."
```

```text
manual step ──► recipe, or ──► ┌─────────────── browser loop ────────────────┐ ──► Setup Audit Trail:
                LLM plans      │ Playwright reads page → indexed controls    │     did Salesforce itself
                               │ Jev chooses operation + control (1 request) │     record the change?
                               │ LLM writes text, only for TYPE_TEXT         │     Jev reads the record
                               │ Playwright executes → observe again         │     and says yes or no
                               │ LLM reviews the page after each click       │
                               └─────────────────────────────────────────────┘
```

- **An LLM** (any OpenAI-compatible endpoint) turns the human sentence into a plan, and reviews the page.
- **Jev** chooses every click, from controls that really exist on the page. It cannot invent a selector or code.
- **Playwright** reads Lightning and Classic Setup pages, and clicks.
- **The run is judged by the audit trail**, not by the agent's own word.
- **23 tested [recipes](docs/recipes.md)** cover known procedures, so nothing is guessed where a path is known.

If a step has Metadata API coverage, deploy it instead. This is for what is left.

More: [docs/run.md](docs/run.md).

## Quick start

Needs Node 22+, Google Chrome, and the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)
with the org already authorised (`sf org login web -a my-sandbox`).

```bash
npm install && npm run build
cp .env.example .env     # add TYPESAFE_API_KEY and LLM_API_KEY
npm link                 # optional: puts sf-autopilot on your PATH
```

```bash
sf-autopilot audit --org my-sandbox --since 2h "Email deliverability was set to System email only"
sf-autopilot run   --org my-sandbox --confirm --step "Set email deliverability to System email only."
```

`--confirm` shows the plan and pauses before every action. Use it until you trust it, and use a scratch org or
sandbox: page text is sent to TypeSafe and to your LLM provider.

## Documentation

| Page | What is in it |
| --- | --- |
| [Proving a step: `audit`](docs/audit.md) | Flags, how a claim is judged, what it cannot confirm, why the audit trail is the check |
| [How far `audit` can be trusted](docs/audit-command-evaluation.md) | 243 labelled cases, every false CONFIRMED found, what is still open |
| [Doing a step: `run`](docs/run.md) | The loop, commands and flags, guards, what Salesforce's UI needed, the code map |
| [Recipes](docs/recipes.md) | The library of tested procedures, how to trial and add one, candidates |
| [Sample runs](docs/samples.md) | Real steps, worded as a person would write them, and what independently checked each |
| [Configuration](docs/configuration.md) | Plugging in a different LLM, provider quirks |
| [What the live runs showed](docs/findings.md) | Where the models are strong, where they wobble, what it costs |

## Limits

- **`audit` reads a record; it does not re-read the org.** Salesforce does not audit everything, and some entries
  are too opaque to prove anything. It is measured, not proven: see the [evaluation](docs/audit-command-evaluation.md).
- **`run` ending `done (reviewer confirmed)` means two models agree.** `confirmed by the Setup Audit Trail` is
  the stronger ending.
- Closed shadow roots, canvas, file uploads, drag and drop and keyboard-only widgets are out of reach.
- It is not cheap: 65k–105k tokens for a 3–5 action step.

## Develop

```bash
npm test     # offline: no model calls, no network
```

## Licence

[GPL-3.0](LICENSE). Use it, change it and share it, commercially or not; if you distribute it or a version you
changed, you must publish that source under the GPL too. For other terms, contact [flxbl](https://flxbl.io).
Parts are derived from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) under MIT: see
[NOTICE](NOTICE).
