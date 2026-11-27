<!-- bump: patch -->
## What Changed

A dark trial for repeat-rule escalation on the "every ask carries its links" rule. When toneGate.askLinksEscalation.enabled is true, confirmed findings are recorded against delivered agent replies in a machine-local ledger. After the third distinct confirmed finding, a draft check flags an operator ask that is missing its links section, unless a recorded override covers that exact draft. The setting is off by default; with it off, the three routes return 404 and nothing changes.

## What to Tell Your User

Nothing changes unless this trial is switched on. When it is, I get a firmer reminder when I keep sending you requests without the links you need.

## Summary of New Capabilities

Three authenticated routes, POST /rule-responses/finding, /rule-responses/draft and /rule-responses/override, behind toneGate.askLinksEscalation.enabled (off by default). They record confirmed ask-links findings, check a draft ask once the rule has repeated three times, and record a per-draft override with its reason. The check is advisory only, and no outbound sender is changed.

## Evidence

Unit, integration and end-to-end tests cover the ledger, the three routes with the setting on and off, and the routes being alive in the production setup.
