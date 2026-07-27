<!-- bump: minor -->

## What Changed

Adds the observation-only first phase of periodic goal realignment. On development
agents, authenticated operator instructions now enter a durable candidate inbox,
semantic classifications are checkpointed before an append-only priority ledger is
updated, and a reviewer records evidence-linked alignment verdicts without changing
the active run.

Priorities do not expire with age. They remain active until a later authenticated
operator message explicitly supersedes them or clearly confirms them addressed.
Incomplete source history, pending classification, projection overflow, and
unsupported contradiction claims all resolve to an indeterminate observation.

The new authenticated status endpoint exposes bounded ledger, candidate, counter,
and latest-verdict state for soak measurement. Phase 1 cannot inject guidance,
modify a plan, block work, send a notice, or create an attention item.

## What to Tell Your User

Your development agent now has the first, watch-only version of a durable compass
for long autonomous runs. It remembers stated priorities until you explicitly
replace them or confirm they are handled, then compares those priorities with the
run's current focus.

For now it only records what it sees. It cannot steer the session, change the plan,
or interrupt you. This lets the team measure whether the compass is accurate before
any later phase is allowed to speak.

## Summary of New Capabilities

- Development agents can retain authenticated operator priorities without silent
  age-based expiry.
- A durable candidate inbox makes uncertain or failed classifications visible
  instead of silently dropping possible priorities.
- Checkpointed extraction makes crash replay deterministic and avoids a second model
  judgment for the same source message.
- A read-only status surface exposes dry-run alignment verdicts and the evidence
  completeness needed to interpret them safely.

## Evidence

- Refusal-first acceptance coverage failed against unmodified source because the
  goal-realignment module did not exist.
- Unit coverage pins priority lifetime, quoted-only confirmation, deterministic
  crash replay, incomplete-source refusal, and two-sided divergence evidence.
- Integration coverage pins authentication, development gating, bounded output, and
  the read-only status route.
- Type checking, lint, production build, and the complete repository test suite were
  run before merge.
