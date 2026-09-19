#!/bin/zsh
# A paced, self-running demo for a screen recording. It tells one story in four parts:
#
#   1. a release checklist has a manual step, and nobody knows whether it was done
#   2. ask Salesforce: its Setup Audit Trail has no record of it
#   3. the agent does the step in a visible browser
#   4. ask Salesforce again: now its own record proves it, and a wrong value is refused
#
#   zsh demo/run-then-audit.sh <org-alias>
#
# Needs TYPESAFE_API_KEY and an LLM key (LLM_API_KEY or ANTHROPIC_API_KEY) in the environment or in .env, and the
# project built (npm run build). It CHANGES the org: email deliverability goes from "All email" to "System email
# only". Use a scratch org or sandbox. Makes paid model calls.
#
# Put this terminal in the bottom half of the screen. The agent's browser opens in the top half, at WINDOW
# (x,y,width,height in screen points). Start recording when the screen clears; stop at the closing summary.
ORG=${1:?usage: zsh demo/run-then-audit.sh <org-alias>}
WINDOW=${WINDOW:-20,40,1472,520}
cd "${0:A:h}/.." || exit 1
[[ -f dist/src/cli.js ]] || { print "Build first: npm run build"; exit 1; }
sf-autopilot() { node dist/src/cli.js "$@"; }

part() { print -P "\n%B%F{cyan}$1%f%b"; sleep 1.2; }                                   # a chapter heading
tell() { for line in "$@"; do print -P "%F{250}  $line%f"; sleep 1.1; done; sleep 0.6; }   # plain-language narration
typed() { print -n -P "\n%F{green}\$%f "; for c in ${(s::)1}; do print -n -- "$c"; sleep 0.010; done; print; sleep 0.5; }
# The narration below each command says what it showed. So every command's real exit code is checked, and the demo
# stops rather than narrate something that did not happen. (It once said "CONFIRMED" under a NOT CONFIRMED.)
#   expect <exit code> <lines of output to show> <pause> <sf-autopilot arguments...>
expect() {
  local want=$1 lines=$2 pause=$3; shift 3
  typed "sf-autopilot ${(j: :)${(q-)@}}"
  local out code
  out=$(sf-autopilot "$@" 2>&1); code=$?
  print -r -- "$out" | grep -v -E '^  [0-9]+\. |^  (start|goal|done when):|^This is the known procedure|^$' | tail -n $lines
  if (( code != want )); then
    print -P "\n%F{red}  UNEXPECTED: exit code $code where $want was expected. Stopping here: the rest of the demo would describe something that did not happen.%f"
    exit 1
  fi
  sleep $pause
}

# A second take must start from "All email", or the agent has nothing to change and Salesforce records nothing.
# The Setup Audit Trail says which way the last change went; put it back, quietly, before the screen is cleared.
last=$(sf data query --target-org $ORG --json -q "SELECT Display FROM SetupAuditTrail WHERE Action = 'sendEmailAccessControl' ORDER BY CreatedDate DESC LIMIT 1" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result.records[0]?.Display??'')}catch{console.log('')}})")
if [[ "$last" == *"to System email only"* ]]; then
  print -P "%F{244}(putting the org back to \"All email\" for the demo, about 75 seconds; start recording when the screen clears)%f"
  sf-autopilot run --org $ORG --headless --step "Set email deliverability back to All email." > /dev/null 2>&1
  sleep 62   # so the reset's own audit entries are older than the one-minute window the first check looks at
fi

clear
print -P "%B sf-autopilot%b   for the Salesforce Setup steps that have no API."; sleep 1.5

part "1. THE PROBLEM"
tell "A release checklist says:  \"After the sandbox refresh, set email deliverability to System email only.\"" \
     "There is no Metadata API for this setting. A person has to click it in Setup, and then say they did." \
     "Nothing checks. So: has anyone actually done it?"

part "2. ASK SALESFORCE, NOT THE PERSON"
tell "Salesforce keeps its own record of every Setup change: the Setup Audit Trail." \
     "We type what should have happened. Jev reads that record and answers yes or no, with a probability." \
     "Jev is not a chatbot. It is TypeSafe's System One model: it returns a typed decision, never text."
expect 2 2 3 audit --org $ORG --since 1m "Email deliverability was set to System email only"
tell "NOT CONFIRMED. Salesforce has no record of it. Nobody did the step."

part "3. LET THE AGENT DO IT        (watch the Salesforce org in the browser above)"
tell "We hand the agent the checklist line exactly as a person wrote it." \
     "Each numbered line below is ONE decision by Jev: the action, the control it picked from the live page," \
     "and p = how sure it was. Jev can only pick controls that really exist. It cannot invent a click."
expect 0 12 3.5 run --org $ORG --window $WINDOW --step "After the sandbox refresh, set email deliverability to System email only."
tell "It matched the step to a tested recipe, chose \"System email only\" in the dropdown, and clicked Save." \
     "Note who declared it finished: not the agent. Salesforce's own audit trail recorded the change."

part "4. PROVE IT        (no browser; this works the same for a step a person did by hand)"
expect 0 6 4 audit --org $ORG --since 3m "Email deliverability was set to System email only"
tell "CONFIRMED, and it shows the exact entry Salesforce wrote, with the old value and the new one." \
     "(The reset we did before the demo is in that window too. It was left out: only a setting's LAST entry says what holds now.)"
tell "It reads the VALUE, not just the setting. Ask about a level nobody set:"
expect 2 3 3.5 audit --org $ORG --since 3m "Email deliverability was set to No access"

part "WHAT JUST HAPPENED"
tell "1. Salesforce had no record of the step, so it had not been done." \
     "2. The agent did it in the browser: an LLM read the instruction, Jev picked each click, Playwright clicked." \
     "3. Salesforce's own Setup Audit Trail recorded the change. That record, not the agent, is the proof." \
     "4. The same check refused a wrong value, and exits non-zero, so a release pipeline can gate on it."
print -P "\n%F{244}  github.com/flxbl-io/sf-autopilot%f\n"; sleep 4
