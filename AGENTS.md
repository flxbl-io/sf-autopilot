# sf-autopilot

Read README.md before editing. Keep the loop small: page -> indexed controls -> operation + target -> execution.

- Three roles, never blurred. The LLM plans and writes text. Jev chooses every action. Playwright reads and executes.
- A model never emits a selector, coordinate, URL to open, or code. Targets are indices into a table this code built.
  The one model-written path (the plan's startPath) must pass `safeStartPath`.
- Never retry a browser mutation. `Stale` may only be thrown before input is sent; anything after input stops the run.
- The sign-in URL carries a session. Never print, log, or persist it, including inside error messages.
- Malformed model output executes nothing. Validate by hand; do not trust JSON mode.
- Stay provider-neutral: the LLM client speaks OpenAI chat/completions over fetch. No provider SDKs.
- `DONE` is not proof. Do not add anything that attests a step without an independent check of the org.
- Tests must not call paid APIs or the network. Inject `post`. A browser test may skip only when Chrome is missing.
- Pin dependencies to exact versions: no `^` or `~`. Build with `npm run build`, not `tsc` directly.
- Do not commit or push unless asked.

Checks: `npm test` (builds first).
