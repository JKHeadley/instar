# Upgrade Fragment — hidden-test-battery-adoption

<!-- bump: patch -->

## What Changed

Added one section to `docs/apprenticeship/PROGRAM-CONCEPTS.md`: "The
Hidden-Test Battery (regression tripwires)" — the durable, generic record of
the mechanism the operator approved on 2026-07-18. The battery is a set of
undisclosed scenarios that each detect the LOSS of an already-valued behavior:
passing means nothing broke, never that growth was achieved (growth stays with
the overseer's judgment). Scenarios stay undisclosed during a drive and are
scored retrospectively (pass / fail / not-triggered, with evidence pointers)
as ONE necessary-not-sufficient input to ladder promotions — a failure can
block a rung, no quantity of passes can earn one. The mechanism itself is
disclosed to the mentee once (results appear in drive reports the mentee can
read); only the scenario list stays hidden. The battery is disposable (a
performed-for scenario is retired; the operator reviews the list at every rung
change) and guardrailed: never a leaderboard, never a mid-drive threat, never
a gate on day-to-day work, never scenarios that can harm real users, data, or
services. Scenarios are preferentially captured from naturally-arising
situations, manufactured only as a last resort and never on production
surfaces.

This is documentation only. No code, config, hook, job, template, or test
changes; no runtime surface; no behavior change for any deployed agent.

## Evidence

- `docs/apprenticeship/PROGRAM-CONCEPTS.md` — the new section (mechanism only;
  deliberately no scenario, agent, or organization content).
- `docs/specs/hidden-test-battery-adoption.eli16.md` — plain-English explainer.
- `upgrades/side-effects/hidden-test-battery-adoption.md` — side-effects
  review; every question resolves to "documentation-only, no runtime surface";
  multi-machine posture unified-via-git; rollback = revert the doc.
- Sanity: the whole-tree stall-coverage CI ratchet
  (`tests/unit/stall-coverage-ratchet.test.ts`) runs green on this tree.

## What to Tell Your User

Nothing changes in how your agent behaves. The apprenticeship program's
documentation now records how regression tripwires work: a small, undisclosed
set of checks that only ever fire when a learning agent LOSES a good habit it
already had — never a score to chase, never a leaderboard, never a gate on
daily work — with results reviewed openly after each drive as one input to
promotion decisions a human still makes.

## Summary of New Capabilities

- None (documentation only). New content: the "Hidden-Test Battery" section in
  `docs/apprenticeship/PROGRAM-CONCEPTS.md`, recording the adopted
  regression-tripwire discipline for the apprenticeship program.
