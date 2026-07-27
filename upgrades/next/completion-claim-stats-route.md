## What Changed

Fixed a rollout-active feature that could never graduate because the evidence its own spec
nominates was unreadable.

`docs/specs/claim-verification-sentinel.md` is `status: approved`, `rollout-disposition: active`,
`rollout-evidence-type: endpoint`, with the graduation criterion
`classified-completion-claims >= 1`. On `main`, that criterion was unevaluable:

- `CompletionClaimVerifier` exists and **is** constructed (`AgentServer.ts:2572`), with
  `monitoring.completionClaimVerification` configured at `dryRun: true`.
- `POST /completion-claim/observe` and `GET /completion-claim/audit` are live, and the audit
  route was **actively recording** (records dated `2026-07-27T17:46Z`, verdicts such as
  `uncorroborated-unknown`).
- `CompletionClaimVerifier.stats()` is implemented and was **called by no route**.
- `/completion-claim/stats` → 404, and the spec's `rollout-evidence-ref`
  (`/completion-claim-verification/stats`) named a prefix that has never existed → 404.

So the feature observed, recorded, and sat in dry-run indefinitely with nothing able to read the
number that would let anyone graduate it — and no error, alarm, or degraded signal anywhere,
because a feature stuck in watch-only mode is indistinguishable from a feature being careful.

Adds `GET /completion-claim/stats` (read-only counters, 503 when the verifier is absent, matching
the sibling audit route) and corrects the spec's `rollout-evidence-ref` to the path that exists.

The response carries both `stats.classifiedTurns` and the spec's own metric name
`classified-completion-claims`, so a rollout check does not need to know the internal field name.

## Evidence

Tests run against **unmodified source first**:

| run | result |
|---|---|
| route reverted | **5 failed** |
| route applied | **5 passed** |
| `tsc --noEmit` | clean |

The retained case worth naming: when the feature has classified nothing, the metric must read `0`
and not be omitted. An absent number is indistinguishable from "the endpoint does not work" —
exactly the confusion that produced this defect.

## What to Tell Your User

Your agent has a safety check that watches its own outgoing messages and flags factual claims it
can't back up. It has been running in watch-only mode, which is correct — it was meant to prove
itself before being allowed to do anything.

It could never have finished proving itself. The plan said "switch it on once it has checked at
least one claim", and pointed at an address for reading that number. The address was never built.
The counting code existed and had been counting the whole time, with nothing able to read it.

So it would have stayed in watch-only mode forever — not failing, just unmeasurable, and looking
from the outside exactly like a feature being cautious.

Nothing about what the check *does* has changed. It still only watches. What changed is that its
progress can now be read, so a decision about switching it on can actually be made.

## Summary of New Capabilities

- Completion-claim verifier counters are readable at `GET /completion-claim/stats`, so a
  rollout-active feature that was structurally unable to graduate now has evaluable evidence.
- The spec's graduation metric is surfaced under its own name, so a rollout check does not depend
  on internal field naming.
- A feature that has classified nothing reports `0` rather than omitting the metric, so "idle" and
  "broken endpoint" are distinguishable.
