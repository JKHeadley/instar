## What Changed
Anything an agent credits to a person, in its notes, rules or messages, can now be traced to the logged message it came from, or says plainly that it has no source. A note can no longer harden unnoticed from "Justin corrected me" into "his standing rule". A history keeps every wording of a claim, on every channel with a log, across an agent's machines. A check runs when a note is written and after a message is sent, and a daily report lists what cannot be supported. The report never edits a note. It uses the agent's own subscription within fixed daily limits and needs no purchased service. Live on development agents, where it only records. Off on every other agent; an update adds no restriction to any existing agent.

## What to Tell Your User
Nothing yet. This is switched on only for development agents, where it watches and records without refusing anything.

## Summary of New Capabilities
- Your agent can answer "did I really say that?" by showing the logged message and every later wording of the claim.
- Notes and messages that credit someone can be checked against the logs, with a source marker or a plain "source unknown".
- A daily report lists notes that credit someone without a checkable source, without changing any note.

## Evidence
New tests across all three tiers: tests/unit/attribution/ (per-channel eligibility on real row shapes, the marker, budgets, the audit, the diff logic, scope), tests/unit/attribution-b23.test.ts and tests/unit/attribution-migration.test.ts; tests/integration/attribution-routes.test.ts through the real routes, including a peer down and a 404 peer; tests/e2e/attribution-feature-alive.test.ts on the production init path, which runs the real hook as a subprocess, confirms the feature is dark on a fleet config, and replays the laptop-rule chain from the case study. Live proof on a throwaway agent and the 72-hour shadow on Echo follow, per the spec's maturation plan.
