# Sample runs

[← README](../README.md)

Steps that were actually run, worded the way a person would write them: against a Developer Edition scratch
org, and two on a sandbox. **"Checked by" is the independent proof**: Salesforce's audit trail, a read of the page
in a fresh browser session with no model involved, or the org's metadata. The agent's own `done` was never taken
as proof.

| Step, as written | Path taken | Result | Checked by |
| --- | --- | --- | --- |
| *Sandbox refresh is done - switch email deliverability back to All email.* | recipe `email-deliverability` | 2 actions, 14 s, `done (reviewer confirmed)` | dropdown read `All email` |
| *After the sandbox refresh, set the email deliverability access level to System email only.* | planned from scratch, forced to start at Setup Home: Quick Find → link → dropdown → Save | 5 actions, 21 s, confirmed | dropdown read `System email only` |
| *Remove the custom field Commit Id from the unlocked package sfpowerscripts-artifact, so the field stays in the org but is no longer locked by the package.* | recipe `unlocked-package-remove-component`: package → View Components → that row's Remove → native `confirm()` | exactly one component released | components table: only `Commit Id` gone |
| *Release the custom setting Sfpowerscripts Artifact 2 from the unlocked package sfpowerscripts-artifact. Keep the custom setting in the org…* | same recipe | 5 actions, 29 s, confirmed | components table empty, package still installed |
| *Change the company default time zone to Australia/Brisbane.* | recipe `company-default-time-zone`; the zone is named into a 400-option dropdown | 3 actions, 16 s, confirmed | audit trail, and SOQL `TimeZoneSidKey` |
| *Set the default workflow user to Integration User.* | recipe `default-workflow-user-set` | 3 actions, 19 s, confirmed | audit trail: "from User User to Integration User" |
| *Set the standard fiscal year to start in April.* | recipe `fiscal-year-start-month`; native `confirm()` accepted | 3 actions, 16 s, confirmed | audit trail: "from 7 to 4", and SOQL |
| *Create a self-signed certificate labelled Autopilot Trial Cert.* | recipe `certificate-create-self-signed` | 3 actions, 21 s, confirmed | audit trail, and Tooling API |
| *Enable Salesforce as an identity provider, signing with the certificate Autopilot Trial Cert.* | recipe `identity-provider-enable` | 5 actions, 22 s, confirmed | audit trail: certificate "from null to Autopilot Trial Cert" |
| *Add an organization-wide email address with display name Release Bot and address …, available to all profiles.* | recipe `org-wide-email-address-add` | 5 actions, 34 s, confirmed | audit trail, and SOQL `OrgWideEmailAddress` |
| *Schedule the recurring data export to include all data, using the default dates.* | recipe `data-export-schedule` | 4 actions, 25 s, confirmed | fresh-session read only; Salesforce does not audit it |
| *Recalculate the sharing rules for Lead.* | recipe `sharing-rules-recalculate`: the Lead row's Recalculate among a dozen alike | **1 click, 9 s, ended there** | audit trail: "Initiated sharing rule recalculation: Lead" |
| *Deployment finished - compile all Apex classes.* | recipe `apex-compile-all-classes` | **1 click, 4 s, ended there** | none exists; the delivered click is the evidence |
| *Permanently erase the deleted custom field Autopilot Trial Field from the Account object.* | recipe `custom-field-erase-deleted`, `--allow-destructive`: Account → Fields & Relationships → Deleted Fields → that row's Erase → "Yes, I want to permanently delete" → Delete | 6 actions, 43 s, **ended by the audit trail** | audit trail: "Permanently deleted custom field Autopilot Trial Field" |
| *Security incident - expire all user passwords now.* | recipe `expire-all-passwords`, `--allow-destructive` | 3 actions, 23 s, ended by the audit trail | audit trail: "Expired all user passwords" |
| *In Activity Settings, turn on 'Show Event Details on Multi-User Calendar View'.* | recipe `activity-settings-change`; the checkboxes have no labels and are named by their row | 2 actions, 27 s, ended by the audit trail | audit trail: "… from off to on" |
| *Allow inbound change sets from the buildkite sandbox into this org.* (and the reverse) | recipe `deployment-connection-allow-inbound`, **on a sandbox**: that row's Edit among ten | 4 actions each way, ended by the audit trail | audit trail: "Authorized / Deauthorized inbound changes from: buildkite" |
| *Licences changed in production - match this sandbox's licences to production.* | recipe `sandbox-match-production-licenses`, on a sandbox | 1 click, 8 s, ended there | Salesforce's own window: "You'll receive an email after license matching is completed" |
| *Set the org default display density to Comfy.* / *Activate the built-in Lightning Lite theme.* | recipes `density-default-set`, `theme-activate`: pure Lightning pages | 1 and 4 actions, confirmed | fresh-session read; Salesforce audits neither |
| *Enable the Account setting that lets users relate a contact to multiple accounts.* | planned; deep link → Edit → checkbox → Save | 3 actions, 22 s, confirmed | `Settings:Account` metadata `true` |
| *Turn off the Account setting that lets users relate a contact to multiple accounts.* | planned | **stopped** before Save: the page warns of permanent data loss | metadata unchanged |
| …the same, with `--allow-destructive` | Save → "I understand this permanently deletes data" → Disable | 5 actions, 28 s, confirmed | metadata `false` |

The last three have Metadata API coverage, so in real use you would deploy them. They are here because the
org's metadata gave an unarguable check while the agent was being debugged.

What a run prints, and a step the planner refuses: [run.md](run.md#working-up-to-a-real-run).
