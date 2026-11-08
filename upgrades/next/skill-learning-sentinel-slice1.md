<!-- bump: patch -->

## What Changed

Slice 1 of the Skill Learning Sentinel (spec `docs/specs/skill-learning-sentinel.md`): the sentinel itself, shipped
**dark** (`monitoring.skillLearning.enabled: false`) and able to run only in **shadow** mode.

- Verified operator requests from Telegram (and, as support only, Slack) are recorded in a per-machine append-only
  ledger with a derived local cache; message text is never stored, only where to find it.
- A batch classifier groups requests by the procedure they ask for and attributes the outcome of the previous run
  (accepted / corrected / redo / unknown…), every verdict recorded through the judgment-provenance log and refused
  when that record did not land.
- A deterministic evidence floor and a static default rung decide when a repeated request has earned a draft; an
  LLM arbiter's verdict is logged beside the default (and its disagreements surfaced as labelled proposals) but
  never acts.
- Drafts are built only from the operator's own messages and the agent's own tool-call outline, linted
  structurally, reviewed by a different model family, and written as **proposals** under
  `.instar/skill-learning/proposals/` — no coding tool can discover them.
- `GET /skills/learned`, `GET /skills/learned/:name`, PIN-gated agree/disagree taps, and a "What I've learned to
  do" section on the console's Learned page (counted on Home).

## What to Tell Your User

Nothing changes yet. When the trial starts, I will begin noticing requests you make repeatedly and, once there is
real evidence a reusable procedure is worth keeping, draft a skill for you to approve or decline on the console.
Until then the feature stays switched off.

## Summary of New Capabilities

- Observe → classify → floor → draft → review → propose, in shadow, with full provenance.
- A console surface and read routes for learned skills and proposals.

## Evidence

Unit, integration and e2e tests at all three tiers (see the PR); side-effects review with second pass in
`upgrades/side-effects/skill-learning-sentinel-slice1.md`.
