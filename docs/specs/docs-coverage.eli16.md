# Documentation coverage — plain English

## What this is

Every time we ship a new feature in instar, the docs are supposed to be updated. In practice they don't always get updated, and the gap between "what the code does" and "what the docs say" grows quietly over months. A recent audit found that the docs cover maybe a fifth of the actual capabilities. About a third of the API endpoints, only a few of the recently-added jobs, none of the token-burn detection system, none of the privacy router that controls whether replies go in public topics or DMs — a lot.

We ran six audit passes trying to find every gap. Each pass found new things the prior pass missed. The audit never converged because the gap is just too large for any single pass to enumerate everything. Sub-agents would search a little, find a chunk, miss the rest. The next pass would find more.

This change replaces the audit-pass approach with a small script that walks the source tree and the docs and computes coverage automatically. Every commit, on every pull request, the script runs in CI and reports what fraction of the shipped capabilities are mentioned in the docs. If coverage drops below a floor, the build fails. If it goes up, the floor can ratchet up too.

## How it works

The script enumerates six kinds of shipped capability — HTTP API routes, CLI commands, scheduled jobs, hooks, skills, and the top-level classes inside each major source subsystem. For each one, it reads every documentation file in the repo and counts how many of them mention it. If a capability is in two or more docs it's marked documented. If it's in exactly one it's partial. If it's in none it's undocumented.

That gives a coverage percentage per category — routes covered, commands covered, jobs covered, and so on. Each category has its own floor, set to the current measured value plus a small buffer for normal churn. PRs that improve docs are the ones that get to raise the floors.

The output is a markdown report and a JSON file, both in the agent's state directory. The markdown is the human-facing version: per-category tables, lists of undocumented items, lists of partial-coverage items. The JSON is for any future automation that wants the data — the weekly audit job we'll set up next will read it directly.

## How it changes things

For the agent and the human user, nothing visible. The script doesn't change any agent behavior, doesn't add any user-facing surface. It runs in CI and quietly enforces a discipline that was never enforced before. New features still have to be documented; the difference is that now the build catches it when they aren't.

For the people writing the docs (Justin, the dev agents working on instar), the change is real. Every PR shows a coverage delta. If you add a feature and forget to document it, CI flags exactly which capability is uncovered. If you fix a doc and raise coverage in a category, the next PR can lift that category's floor so the bar moves with you. The doc-and-code state stays roughly in sync because the gate keeps it that way.

For the strategic picture, this is what closes the audit loop. The agent-driven audits we just ran proved the shape of the gap — eleven kinds of drift, hundreds of specific items. The fix work is enumeration: write the missing pages, fix the wrong claims, add the missing items to tables. The script is what prevents the next eight months of feature work from quietly rebuilding the same gap. It's a one-line CI check that replaces what used to take five parallel sub-agents and four iteration passes.

## Initial coverage numbers

The script's first run against current main:

- Overall: 15% of the 880 shipped capabilities have any documentation mention
- Routes: 13% (about 36 of 457 endpoints have a doc mention)
- Commands: 42% (7 of 31)
- Jobs: 61% (4 of 14 default jobs)
- Hooks: 25%
- Skills: 86% (the highest — skills.md does a thorough job, only `instar-dev` and `spec-converge` are missing because they're internal-only)
- Classes: 10% (28 of 354 — the big gap, mostly internal subsystems)

The initial CI floors are set to those values minus a few points to allow normal churn. As doc-update PRs land, they ratchet the floors up. The next pass — Phase 2 of this autonomous-mode sprint — is the doc-update work itself.

## Why it converges

Manual audit passes never converged because each pass searched stochastically and missed items the next pass would find. This script doesn't search — it enumerates. It walks every file under `src/server/routes.ts`, every command in `src/commands/`, every job in `src/scaffold/templates/jobs/`, every hook, every skill, every PascalCase file in the right subsystems. There's no missing-the-haystack-for-the-needles. If a capability exists at one of the canonical locations, it's counted. If it isn't there, it doesn't exist as a shipped capability.

The same logic applied to docs: every `.md` file in `site/src/content/docs/` plus `README.md` is loaded, and substring matching tells us whether the capability is mentioned anywhere. The result is the same on every run for the same source state. No model, no probability, no missed items.

That's why this is the structural answer — and why it ends the audit-pass loop rather than just running it more times.
