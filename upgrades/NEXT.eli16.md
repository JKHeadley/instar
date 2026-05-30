# vNEXT — plain English overview

## What this change is

Your agent has a feature called the "Failure-Learning Loop" — it watches for
things that go wrong (a CI run fails, a recent commit gets reverted, an
internal health-check trips) and writes a little record so you can later ask
"why do my agents keep breaking?" and get a real answer instead of vibes.

The loop has a config switch for each kind of failure it watches. Some of
those switches were checked in months ago but never connected to anything —
flipping them on did literally nothing, the loop just pretended the source
was active. That's exactly the failure mode the post-mortem yesterday named
as "specced but not wired" — a real, repeat offender.

This change does two things:

1. **Loud warning when you flip on a switch that isn't wired up.** If you set
   `monitoring.failureLearning.sources.regression: true` or
   `monitoring.failureLearning.sources.degradation: [...]`, the agent now
   says, at startup: "you turned this on but nothing implements it yet —
   set it back off until the impl ships." Before, those switches were silent
   no-ops.

2. **A new automated check that catches a different bug class.** When you do
   a fresh `instar init`, certain hooks get installed. When the agent
   auto-updates, a different bit of code re-installs hooks. We had at least
   one case in the last release where the two lists disagreed — a fresh
   agent was missing a hook that existing agents had, because nobody had
   noticed the divergence. The new check reads both lists and refuses
   to commit any change that creates a new divergence (with a small
   allowlist for documented technical debt).

## What already exists

- The Failure-Learning Loop itself, with ledger + analyzer + API at `/failures/*`.
- The `ci` and `revert` ingestion sources, which actually work and capture events.
- The `regression` and `degradation` source flags in config defaults
  (just no implementation behind them).
- `PostUpdateMigrator` (the auto-update path) and `installHooks()`
  (the fresh-init path), both of which write hooks to disk independently.

## What's new

- Boot-time warning if `regression` or `degradation` source flag is on but
  unimplemented.
- Unit test that pins the source-flag-to-poller wiring so future regressions
  fail the test suite instead of silently disabling the loop.
- Unit test that diffs the fresh-init hook list against the auto-update hook
  list and fails on any new divergence.
- A small allowlist of currently-accepted divergences (six entries, with
  rationale per entry; soft cap of ten so the list can't quietly grow).

## What you need to decide

Nothing. This is structural backstop, no configuration involved. Existing
agents pick up the warning on next process restart (auto-update will trigger
that). Future PRs that try to introduce a new fresh-init-vs-auto-update gap
will fail their tests.

## How to verify it worked after deploy

If you haven't touched `monitoring.failureLearning.sources` in your config,
you should see exactly the same behavior. If you flipped one of the
unimplemented sources on, you'll see a one-line warning at startup.

To start actually USING the Failure-Learning Loop on your agent, set
`monitoring.failureLearning.sources.ci: true` and `sources.revert: true`
in `.instar/config.json`. The substrate has been ready since late April;
this PR just adds the tests around it. Echo's local config is being flipped
out-of-band as a dogfooding step.

## Why this matters more than it might look

The 14-day fix-shape rate to main is around 19% — we've been shipping a lot
of bugs and finding out from users instead of from instrumentation. The
Failure-Learning Loop is the meta-trace that turns "we keep shipping bugs"
into "here are the three patterns most of them share." But it was sitting
unused because the ingestion sources were silent. This PR closes one half
of that gap (the wiring-test + the unimplemented-source warning); flipping
the working sources on for each agent closes the other half. Several more
PRs from the same post-mortem will follow.
