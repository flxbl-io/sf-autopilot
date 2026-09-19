# What the live runs showed

[← README](../README.md)

One scratch org and one sandbox. First a single setting (Account Settings → *Allow users to relate a contact to
multiple accounts*), toggled on and off twelve times and judged by retrieving `Settings:Account` from the org;
then the steps under [samples.md](samples.md). A handful of tasks on two orgs: it says nothing about reliability
in general. What it did show:

## It works

- **Lightning is reachable.** Setup Home: 96 open shadow roots, 0 closed, 127 controls. The Classic page inside
  the iframe was read and driven. Sign-in through `sf org open` worked with no password.
- **The agent can do the work.** In every run that reached Save, the org's metadata changed correctly.
- **Salesforce audits most of this**, which turns "no Metadata API" from "no proof" into a SOQL query. See
  [audit.md](audit.md#why-the-audit-trail-is-the-check).
- **A recipe beat planning on the same task**: 2 actions and 14 s, against 5 actions and 21 s after two failed
  attempts at finding the page.

## Jev chooses well and stops badly

- **What is on the page decides more than the model does.** Every recipe that failed its first trial failed
  because the right control was not in the table, or the proof was not in the text: crowded out by a long
  dropdown, cut off by a size limit, hidden in a disabled checkbox. Once the control was offered, Jev chose it
  at p≥0.9 nearly every time. None of the trial failures was a wrong choice among visible, distinguishable options.
- **Jev's `DONE` cannot be trusted alone.** It declared `DONE` at p=0.87 while Salesforce's "this permanently
  deletes data" confirmation was still open, and the setting was unchanged. The reviewer exists because of this.
- **Jev does not reliably stop.** It over-claims `DONE` (above) and it under-claims: after finishing a step it
  went looking for more to do. Completion has to be judged from outside the loop.
- **A correction can make Jev too timid.** Told once that a dialog was open, it would not claim `DONE` again
  even after dealing with it, and the run ended `blocked` with the org correct. Hence the reviewer looks after
  every click.

## Identical controls

- **They split Jev's probability.** Two `Save` buttons scored 0.55 and 0.30. A naive confidence threshold would
  have flagged a correct click, so sum over identical labels before gating on probability.
- **They are dangerous, not just inefficient.** Asked to release one component from a package, the agent faced
  four links all labelled `Remove`, chose blind at p=0.92, and released **two**. Row context fixed the choice,
  and reviewing after every click fixed the overshoot. Any control the reader cannot tell apart from its
  neighbours is a control Jev picks at random, however confident it sounds.

## Most failures were in observation, not in the models

Acting on a loading skeleton, reading the old form after a save, missing the iframe while Lightning swapped it,
and not reading disabled checkboxes. Each one is now a regression test, and the timing ones were checked to fail
without their fix. The full list: [run.md](run.md#what-salesforces-ui-needed).

## Cost

About 17k input tokens per Jev request on a Setup page (the tree dominates), so 65k–105k tokens for a 3–5 action
step, plus one LLM call to plan and one or more to review. A clean run took 21–28 seconds.

## What to look at first on your own org

1. **`diagnose` on Setup Home and on one Classic-backed Setup page.** `closed_shadow_suspects > 0` means
   components nothing can enter. That is the one obstacle Playwright does not remove.
2. **Does it get there?** Quick Find → result → setting → Save is the core skill.
3. **Are the probabilities informative?** If wrong clicks arrive with a low `topTargets[0].probability`, a
   threshold can hand off to a human. If they arrive with a high one, it cannot.
4. **Cost per step.** `jevRequests` × tokens. Setup pages carry many more controls than a typical web page.
