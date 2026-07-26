# Side-Effects Review — the dashboard showed "Error rate: 50%" beside "Routing is healthy"

**Version / slug:** `dashboard-error-rate-unobserved`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 (reduced independence, disclosed)`

## Summary of the change

The LLM Activity insight collector computed `overallErrorRate = totalReal > 0 ? totalErrors/totalReal : 0`
and rendered it as `Error rate: 0%`, then asserted a health fact whenever no anomaly had been flagged:

    "Routing is healthy — 0 checks ran with no check failing a meaningful share of its calls."

Two failures fell out of that. With an empty 24-hour window the panel claimed health from no data —
and the sentence's own denominator ("0 checks ran") contradicted its claim. Worse, with a genuine
failure below the anomaly floor the panel showed **`Error rate: 50%` beside "Routing is healthy"**,
because the per-feature loop correctly required `f.realCalls >= MIN_REAL_CALLS` before flagging while
the health sentence had no such condition.

`MIN_REAL_CALLS = 5` is declared at the top of this same file, commented "minimum real calls before
an error-rate is statistically meaningful". The fix applies that existing, already-honoured constant
to the aggregate: the rate is `null` (rendered "no calls yet") at zero calls, a sub-floor window says
so plainly, and **a real failure is surfaced ahead of any evidence caveat**.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| the `facts` branch order | `invariant` | Deterministic. Anomalies are checked FIRST and unconditionally, so no caveat can displace a warning. |
| the sub-floor caveat | `invariant` | A comparison against the file's existing `MIN_REAL_CALLS`. Gates only the reassuring conclusion. |
| `Error rate` rendering | `invariant` | `null` at zero calls → a string saying why, never a computed default. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is blocked — this is a read-only dashboard collector with no gating authority. The analogue
is **withholding a health claim from a genuinely healthy window**: a window with 1–4 clean calls now
reads "too few to say" instead of "healthy". Bounded, and the real rate is still displayed beside the
call count so the reader can judge for themselves. At 5+ calls the claim returns unchanged
(demonstrated: 10 clean calls → "Routing is healthy", byte-identical to before).

## 2. Under-block

**What failure modes does this still miss?**

- The floor is a call count, not a confidence interval. 5 clean calls yields "healthy" though a real
  interval would still be wide. Deliberate: this reuses the file's existing constant rather than
  inventing a second, differently-tuned threshold in the same file.
- `busiest` is still reported whenever `realCalls > 0`, which is honest (it is a count, not a rate).
- The 24h window itself is not surfaced as a caveat when the process started minutes ago — a
  short-uptime window looks the same as a genuinely quiet one. Out of scope here; noted rather than
  silently skipped.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The defect is in how this collector renders its own aggregate, so the fix belongs in it. No
shared helper was extracted: the sibling instance in `CoherenceGate` (PR #1648) has different types
and a different output shape, and abstracting over two instances would be the premature-generalisation
mistake this project's own spec review caught elsewhere.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

No. Pure presentation, zero authority: no branch blocks, delays or alters anything, and the collector
is consumed only by the insights read surface. There is no misclassification path that can deny
something, because nothing is denied. The change strictly reduces the panel's capacity to mislead.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. Every branch is a deterministic comparison on counted calls against
a constant already present in the file. The one asymmetry is deliberate and stated in a code comment:
anomalies are evaluated first and unconditionally, so thin evidence can never suppress a warning —
only the reassuring conclusion requires evidence behind it.

## 5. Interactions

- `overallErrorRate` is a local; verified by grep that nothing outside this file reads it.
- `InsightMetric.value` is typed `string`, so "no calls yet" needs no type change and no consumer
  performs arithmetic on it.
- The existing E2E (`tests/e2e/insights-alive.test.ts`) seeds 6 calls with 3 errors — above the floor,
  so it still routes to the anomaly branch and still asserts `/50%/`. Re-run: passes unchanged.
- A visible grammar fix falls out of the plural handling: "1 checks are failing" → "1 check is failing".
- No persistence, no config, no migration: every value is computed per call from the ledger.

## 6. External surfaces

The `/insights` payload for the `llm-activity` page changes in two places: `Error rate` may read
"no calls yet" instead of "0%", and the first fact may be a caveat rather than a health claim. Both
are display strings already typed as free text. The feature ships dark on the fleet (dev-agent gated,
dryRun), so exposure is limited to development agents today.

## 6b. Operator-surface quality

This is the whole point of the change. An operator glancing at the panel during a quiet window
previously read "Error rate: 0% · Routing is healthy" and would reasonably conclude the routing layer
was fine. They now read "no calls yet" and "nothing to judge yet". And in the sub-floor case they no
longer see a 50% error rate sitting next to the word "healthy" — the panel stops contradicting
itself. None of the new wording is alarming: "nothing to judge yet" says nothing is wrong AND nothing
is known.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no new state.** The collector derives everything, per call,
from the per-process metrics ledger that already existed. Each machine reports its own LLM activity,
which is correct: a call was made by a specific process. No replication path is needed because nothing
is stored, and no `machine-local-justification` marker is required because no new machine-local state
is introduced.

## 8. Rollback cost

Trivial: revert one commit touching one source file plus its new test. No migration, no persisted
state, no config key. A consumer written against the new strings sees the old ones again, and the old
strings' failure mode is the one documented above.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned — a standing
instruction in this session prohibits spawning subagents unless the operator requests it. The review
lenses were applied by the author. That is **reduced independence**, recorded as such rather than
presented as a concurring second pass.

What author-applied review actually caught and changed:

1. **The first draft ordered the branches wrongly**, putting the sub-floor caveat ahead of the
   anomaly message. Today no anomaly can occur below the floor (a feature needs `>= MIN_REAL_CALLS`
   to flag, so `totalReal < MIN_REAL_CALLS` implies none) — but that is an arithmetic coincidence,
   not a guarantee. Reordered so anomalies win unconditionally, and the reasoning is in a comment so
   a future edit to either constant cannot silently reintroduce suppression.
2. **My own first test asserted the wrong thing** and failed on correct output: it matched
   `/routing is healthy/i`, which the caveat legitimately contains ("too few to say whether routing
   is healthy"). Corrected to assert the absence of the AFFIRMATIVE claim. Worth recording because
   this project's Tier 1 is about instruments that mis-measure — including my tests.
3. The consumer check was run rather than assumed, establishing that `overallErrorRate` is local and
   that `InsightMetric.value` is already a string.
