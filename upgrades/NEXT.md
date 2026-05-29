# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**The Usher's precision loop is now wired — `acted` can finally move off zero.**

The Usher (rung 4 of continuous-working-awareness) fires "re-surface" signals
when a faded context becomes relevant again, and exposes a precision read
(`acted / fired`) that is the hard precondition for ever letting it interrupt
mid-task (rung 5). But `UsherSignalStore.markActed` — the precision *numerator* —
had **no caller anywhere**. So `acted` stayed 0 on every topic and precision was
structurally pinned at 0: the gate could never be satisfied by data. The Usher's
accuracy half had shipped asleep — the exact "shipped but asleep" trap the rest
of this project exists to kill, hiding inside our own accuracy meter.

This closes the loop with two correlation paths, both reducing to "does some
probe text COVER a fired signal's proposition?":

1. **Auto-use (path a).** When the agent's genuine reply goes out on a topic and
   it actually *uses* a re-surfaced context the Usher flagged, that signal is
   marked acted (`via: 'use'`). Wired on the outbound `/telegram/reply` path.
2. **Miss-map (path b).** When the user has to *correct* the agent (a
   HumanAsDetector signal) on a context a recent nudge had already flagged, that
   nudge was a genuine catch the agent ignored — still a true positive. It's
   marked acted (`via: 'miss'`). Wired right after the inbound human-detector
   observe seam.

Matching is deliberately precision-over-recall (≥2 shared salient terms AND ≥50%
coverage, within a recency window): a falsely-*high* precision is the dangerous
direction since it gates interruption, so under-crediting a fast reply is
acceptable, inflating the gate is not. Everything is best-effort and never throws
into the message/delivery path.

`GET /usher/metrics` now also reports `acted_by_use` and `acted_by_miss` so the
precision numerator is visible split by which path confirmed usefulness.

## What to Tell Your User

The Usher now measures whether its mid-task reminders were actually useful — on
its own, two ways: when my next reply uses a reminder, and when you later have to
correct me on something a reminder had already flagged. That useful rate is the
number that has to look good before the Usher ever earns the right to interrupt me
(the final rung), so instead of sitting stuck at zero it can now gather real
numbers as we work. Nothing for you to set up — it just runs, and I can show you
the per-conversation numbers whenever you want them.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Usher precision numerator wired | Automatic — `markActed` is now called from the outbound-reply path (agent used the nudge) and the inbound human-detector seam (user corrected on it). |
| `acted_by_use` / `acted_by_miss` split | `GET /usher/metrics?topicId=N` returns the precision numerator broken down by which correlation path confirmed usefulness. |
| `UsherActedCorrelator` | Pure, exported coverage matcher (`salientTerms`, `contextCoveredBy`, `findCoveredSignalIds`, `markActedByCoverage`) + two thin wiring wrappers (`creditUsherOnOutbound`, `creditUsherOnMiss`). Unit-tested both-sides-of-the-boundary. |

## Evidence

- Unit: `tests/unit/UsherActedCorrelator.test.ts` — 20 cases covering salient-term
  extraction, coverage thresholds (covers vs single-coincidental-word vs
  low-coverage vs empty), recency-window filtering, the via-split + backward-compat
  on `markActed`, and the two wrappers' guards.
- Integration: `tests/integration/usher-routes.test.ts` — `GET /usher/metrics`
  exposes the `acted_by_use`/`acted_by_miss` split + precision; legacy topics
  report the split as 0; source-guards prove `routes.ts` calls
  `creditUsherOnOutbound` and `server.ts` calls `creditUsherOnMiss` after the
  human-detector observe (anti-shipped-but-asleep).
- E2E: `tests/e2e/usher-precision-lifecycle.test.ts` — boots the real route tree
  on a live HTTP server, proves the pre-fix state (precision pinned at 0 with a
  fired-but-unacted nudge), then drives BOTH paths: a reply that uses the context
  flips precision 0 → 1.0 (`acted_by_use`), an off-topic reply does not, and an
  inbound correction credits a prior ignored nudge (`acted_by_miss`) — all visible
  over real HTTP at `GET /usher/metrics`.
