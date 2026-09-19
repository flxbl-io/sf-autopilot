# Proving a step: `audit`

[← README](../README.md)

Type what should have happened. Jev reads Salesforce's Setup Audit Trail and says whether it shows that change,
to that value, and which entry proves it. No browser, no run, and it does not matter who did the work.

- [Usage](#usage)
- [Flags and exit codes](#flags-and-exit-codes)
- [How a claim is judged](#how-a-claim-is-judged)
- [What it cannot confirm](#what-it-cannot-confirm)
- [Why the audit trail is the check](#why-the-audit-trail-is-the-check)
- [The same check, after a `run`](#the-same-check-after-a-run)

## Usage

The step goes in `--step`, `--step-file`, or simply as the last argument.

```bash
sf-autopilot audit --org my-sandbox --step "Set the fiscal year to start in April, and let admins log in as any user"
sf-autopilot audit -o my-sandbox --since 2h --by priya@example.com "Set the default workflow user to Integration User"
sf-autopilot audit -o my-sandbox --since 1d --json --step-file release-steps.md    # for a pipeline
```

```text
$ sf-autopilot audit --org my-scratch --since 3h --step "Set the fiscal year to start in October, and allow administrators to log in as any user"
Setup Audit Trail of my-scratch, last 3 hours: 45 entries
  ...
NOT CONFIRMED  p=0.03  Set the fiscal year to start in October
CONFIRMED      p=0.90  Allow administrators to log in as any user
    recorded: 04:36:42  overridegrantaccessenabledoff  Changed Administrators Can Log in as Any User from off to on  (admin@example.com)

NOT CONFIRMED: 1 of 2 claims                                                                       # exit code 2
```

A real check (the username is changed). Salesforce had recorded the fiscal year going "from 7 to 4", April, so
October is refused. The other claim is confirmed and shown with the entry that proves it.

**Describe the state you want to hold, not the steps on the way to it.** "Set it to July, then to April" cannot
be confirmed; "the fiscal year starts in April" can.

## Flags and exit codes

| Flag | Meaning |
| --- | --- |
| `--since` | The window: `30` (minutes), `45m`, `2h`, `1d`. Default `30m`. From a day up, entries print with their date. At most the newest 200 entries are read; a window that fills that is flagged, because its oldest changes were cut off. |
| `--by <username>` | Keeps only that user's changes (case-insensitive, the whole username). When nothing matches, it lists who did make changes. `--by ""` is an error, not "anyone": an unset shell variable must not drop the filter. |
| `--json` | One object and nothing else: `confirmed`, `claims` (each with `probability`, `confirmed`, the supporting `entry`, `undone`, `note`), the `entries` judged, and `notes` with every caveat. An error, including unparseable arguments, is `{"confirmed": false, "error": "..."}`. |
| `--no-split` | Judge the whole prompt as one claim. |

A prompt that starts with a dash (a bulleted list) needs `--step="- ..."` or `--step-file`.

Exit codes, with or without `--json`: `0` confirmed, `2` not confirmed, `1` error.

Entries are sent to Jev without usernames, so a prompt that names a person is judged on *what* changed. Use
`--by` for *who*.

## How a claim is judged

**1. The prompt is split into claims.** One yes/no over "A and B" would hide which half failed, so an LLM splits
the prompt. Code checks the split before believing it: every claim must be made of the prompt's own words, and
no word may go missing except what joined the parts or framed the question ("and", "did", "please check
whether"). A split that dropped "to April" would let any fiscal-year entry confirm the claim. If the split fails
that check, the LLM errors, or no `LLM_API_KEY` is set, the prompt is judged whole and the output says why. A
prompt with nothing joining two parts skips the LLM altogether.

**2. Jev sees only the last entry about each setting.** A reset followed by the real change once scored a true
claim 0.72 and refused it, because the opening entry read the opposite way. The whole trail is still printed,
with a note saying what was left out.

**3. Each claim gets its own request, with three questions:**

| Question | Type | Passes when |
| --- | --- | --- |
| Do the entries show this was done, to this value? | yes/no | p ≥ 0.80 |
| Does a later entry undo it? (a field created, then deleted) | yes/no | p < 0.50 |
| Which entry proves it? | one entry, or `NONE` | an entry is named |

**4. A claim is confirmed only when every answer agrees**, and one more check made in code agrees too: the proof
must be the *last* entry about that setting, for the two wordings that name one ("Changed X from a to b",
"X Enabled/Disabled"). A likely claim with `NONE`, or with an unreadable answer, is not confirmed, and says so.
If no claim gets a readable answer, the command fails instead of reporting a verdict.

**5. The prompt is confirmed only if every claim is.**

Why a step that no longer holds needs two checks: "Set the fiscal year to July" was once confirmed at p=0.96
against a trail that set it to 7 and, twelve minutes later, to 4. Jev's "undone" question catches most of
these; the code check caught the two it missed.

Why each claim is judged alone: with every claim in one request, a plainly true claim scored 0.78 and 0.80 on two
identical runs, around the cutoff, and a person got NOT CONFIRMED for a change that had been made. Alone, the
same claim scores 0.90–0.91. The requests go out together, so it takes no longer.

## What it cannot confirm

- **That something did NOT happen.** There is no entry to name.
- **A bare audit action code** (`changedDefaultWorkflowUser`). A code says a setting was touched, not to what.
- **What Salesforce does not audit.** Releasing a component from an unlocked package, scheduling the data export,
  compiling all Apex classes, the display density, activating a Lightning theme and matching production licences
  leave no entry. When the window is empty no model is asked; the command says so and names these.
- **An entry too opaque to read.** Salesforce recorded one change only as `reportEscapeCharsPrefOffOn has
  changed`. Jev gave it 0.03 against "turn on 'Disable Formulas in Exported Reports'", rightly: nothing ties the
  two together.

On 243 labelled cases the shipped design got 232 right, with one false CONFIRMED and ten true claims refused.
Both case sets were tuned on, so that is a fit, not a forecast. The numbers, every false CONFIRMED found, and
what is still open: [audit-command-evaluation.md](audit-command-evaluation.md).

## Why the audit trail is the check

These steps have no Metadata API, so there is nothing to retrieve and compare. But Salesforce keeps its own
record of every Setup change, and it answers plain SOQL. No model and no web page are involved in producing
that record.

Against one real window of the trail:

| Step put to Jev | p |
| --- | ---: |
| Set the standard fiscal year to start in April. *(recorded: "from 7 to 4")* | 0.96 |
| Set the default workflow user to Integration User. | 0.98 |
| Enable Salesforce as an identity provider, signing with the certificate Autopilot Trial Cert. | 0.87 |
| Set the standard fiscal year to start in **October**. *(right setting, wrong value)* | 0.04 |
| Set the default workflow user to **Security User**. | 0.03 |
| Set email deliverability access level to System email only. *(nothing to do with the record)* | 0.04 |

## The same check, after a `run`

After each run the tool asks Salesforce what it recorded:

```text
done (reviewer confirmed): 3 actions, 4 Jev requests, 16210 ms. Trace: artifacts/20260919T042058Z

Setup Audit Trail (Salesforce's own record of this run):
  04:21:14  orgFiscalYearStartMonth        Changed fiscal year start month from 7 to 4
  => recorded "orgFiscalYearStartMonth", as this recipe expects.
  => Jev, reading that record: it CONFIRMS the step (p=0.96)
```

- **Two checks.** A recipe names the audit action it leaves (`"audit": "orgFiscalYearStartMonth"`), an exact
  match. And Jev reads the entries, which covers a freshly planned step with no expected code.
- **Below 0.80, a run that ended `done` exits non-zero.** Tune the threshold on your own org.
- **The trail can end a run.** It is judged beside the page reviewer after every click that changes the page, and
  either can end the run; the result says which (`confirmed by the Setup Audit Trail`). Many Classic settings
  pages never show their own proof: Save sends the browser to Setup Home, or the embedded page just goes away.
- **After a run it shows a change was made, not that it still holds.** A later change leaves the earlier entry in
  place. The `audit` command goes further and refuses a change the trail shows undone.
- **An empty trail proves nothing** unless the recipe expects an entry.
