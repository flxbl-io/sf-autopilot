# Recipes

[← README](../README.md)

A recipe is a tested procedure for one Setup task that has no API. A step that matches one follows it instead of
an invented plan.

- [Why recipes](#why-recipes)
- [How one is chosen](#how-one-is-chosen)
- [State and action](#state-and-action)
- [Trialling a recipe](#trialling-a-recipe)
- [Adding one](#adding-one)
- [Candidates](#candidates)

## Why recipes

Live runs showed where this agent is strong and where it wobbles. Jev executes a known path well. The wobble is
in *finding* the way: a planner guessing a deep link, Jev torn between the sidebar Quick Find and the global
search box. A recipe removes the guessing: 2 actions and 14 s, against 5 actions and 21 s planned from scratch.

A recipe is data, not code ([recipes/](../recipes)): where to start, the known UI path, what "done" looks like,
whether it is destructive, the audit action it leaves, the IdeaExchange idea asking for an API, and a `verified`
list. The step's own words still supply the specifics (which level, which component), so a recipe needs no
parameters.

```bash
$ sf-autopilot recipes        # 23 verified, 5 candidates
apex-compile-all-classes               verified 2026-09-19
certificate-create-self-signed         verified 2026-09-19
company-default-time-zone              verified 2026-09-19
connected-app-block                    CANDIDATE, not yet run live  [destructive]
…
```

## How one is chosen

Jev picks the recipe in one request, or `NONE`. Below 0.60 probability, or with no match, the planner plans from
scratch.

**Only a live run earns a `verified` entry, and only verified recipes drive a run.** A candidate is a path
written from memory; it takes `--candidates` to let one steer. `--no-recipes` turns the library off.

## State and action

Most recipes leave a *state* a later visit can read back. Some only start something: a compile, a sharing
recalculation, a licence match. On a large org those run for minutes or hours and the page just hangs, so there
is nothing to watch for.

An `action` recipe names the control that fires it (`commit`). Delivering that click, with the page responding,
**is** the job: the run ends there. It does not wait for a result, and it cannot click twice.

## Trialling a recipe

```bash
sf-autopilot trial --org my-scratch-org            # every untested recipe that has a trial step
sf-autopilot trial --org my-scratch-org --only certificate-create-self-signed
```

A trial asks four separate questions, so a failure says where it failed:

1. **matched** — given only the trial step and the whole library, does Jev pick this recipe? This tests `when`.
   (Across some 30 trials against a library of up to 25, it picked the right recipe every time but one, at
   p=1.00. The one miss was the recipe's fault: a `when` that described allowing a connection did not cover
   withdrawing it.)
2. **ran** — does the run end `done`, confirmed by the reviewer (or, for an action, with its firing click delivered)?
3. **held** — in a **fresh browser session**, does the done-condition still hold? A change that was never saved
   looks fine in the session that made it and is gone in the next. Skipped for an action.
4. **audited** — if the recipe names the audit action it leaves, did Salesforce record it? No model is involved.

Nothing is stamped automatically. Read `artifacts/trials/<id>.json`, then write the `verified` entry yourself,
saying what you saw.

## Adding one

1. Write `recipes/<id>.json` with a `trial.step` worded the way a person would write it.
2. Trial it, fix the path from the trace, and trial again.
3. Describe in `when` what the procedure is *and is not*. That sentence is all Jev has to match on.
4. A candidate that cannot be trialled (sandbox-only, needs a licence, would lock the org) must say why in `notes`.

## Candidates

Five recipes are written but not yet proven live: `connected-app-block`, `connected-app-policy-edit`,
`person-accounts-enable`, `state-country-picklists-enable`, `user-access-policy-activate`. Each says why in its `notes`.

Recipes that answer an IdeaExchange request for an API:

| Recipe | Idea |
| --- | --- |
| `email-deliverability` | [Accessing the Email Deliverability via Apex code & API](https://ideas.salesforce.com/s/idea/a0B8W00000GdXD2UAN/accessing-the-email-deliverability-via-apex-code-api) |
| `data-export-schedule` | [API Access to Weekly Export Service](https://ideas.salesforce.com/s/idea/a0B8W00000GdaZVUAZ/api-access-to-weekly-export-service) |
| `org-wide-email-address-add` | [Easier method to update Organization-Wide Email Addresses](https://ideas.salesforce.com/s/idea/a0B8W00000GdfnPUAR/easier-method-to-update-organizationwide-email-addresses) |
| `user-access-policy-activate` *(candidate)* | [Deploy User Access Policy in an Active status](https://ideas.salesforce.com/s/idea/a0BHp000016LuoYMAS/deploy-user-access-policy-in-a-active-status) |

Asked for on IdeaExchange, and not a recipe yet:

| Manual step | Idea |
| --- | --- |
| Re-verify the email domain after every sandbox refresh | [Persist Email Domain Verification Across Sandbox Refreshes](https://ideas.salesforce.com/s/idea/a0BHp000019OpcuMAC/persist-email-domain-verification-across-sandbox-refreshes) |
| Remove a custom label from a managed package | [Remove Custom Labels from Managed Packages](https://ideas.salesforce.com/s/idea/a0B8W00000GdXBzUAN/remove-custom-labels-from-managed-packages) |

No IdeaExchange entry was found for releasing a component from an unlocked package, so that recipe links none.
[Browserforce](https://github.com/amtrack/sfdx-browserforce-plugin)'s plugin list is another backlog: each plugin
exists only where there is no API.
