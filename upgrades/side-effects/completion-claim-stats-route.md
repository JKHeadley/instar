# Side-effects review — `GET /completion-claim/stats`

**Change:** adds a read-only counters endpoint for the completion-claim verifier, and corrects
the `rollout-evidence-ref` in `docs/specs/claim-verification-sentinel.md` from
`/completion-claim-verification/stats` (a prefix that does not exist) to `/completion-claim/stats`.

**Discovered:** 2026-07-27, while checking — before proposing a new feature — whether a
claim-review capability already existed. It did, and it could not graduate.

## The condition

`docs/specs/claim-verification-sentinel.md` is `status: approved`, `rollout-disposition: active`,
`rollout-evidence-type: endpoint`, with a graduation metric of
`classified-completion-claims >= 1`. Verified on `main`:

- `CompletionClaimVerifier` exists and **is** constructed (`src/server/AgentServer.ts:2572`).
- `monitoring.completionClaimVerification` config is present with `dryRun: true`.
- `POST /completion-claim/observe` and `GET /completion-claim/audit` are live —
  `/completion-claim/audit` returns 200 and was **actively recording** (records dated
  `2026-07-27T17:46:20.971Z`, `dryRun: true`, verdicts such as `uncorroborated-unknown`).
- `CompletionClaimVerifier.stats()` is implemented (`src/monitoring/CompletionClaimVerifier.ts:231`)
  and **called by no route**.
- `/completion-claim/stats` → 404. `/completion-claim-verification/stats` (the spec's ref) → 404.

So the feature runs, observes, and records — while the evidence its own spec nominates for
graduation is unreadable. It cannot progress, and nothing surfaces that it is stuck.

**Correction of record:** an earlier filing of this said "the route does not exist anywhere."
That was wrong — the observe and audit routes exist under a different prefix. The accurate
finding is narrower: no *stats* surface exists at any prefix, and the spec's ref points at a
prefix that never did. Recorded rather than quietly amended.

## 1. Over-block — what legitimate input does this reject?

None. New read-only route; rejects nothing that previously worked. It 503s when the verifier is
absent, which is the same contract the sibling audit route already uses — deliberately matched so
"feature off" reads identically across both surfaces rather than one 404ing and one 503ing.

## 2. Under-block — what does this still miss?

- **It does not make the feature graduate.** It makes graduation *evaluable*. Whether the
  criterion is met is a separate, later, evidence-driven decision that belongs to the operator.
- **Local scope only.** The audit route already owns the pool projection; adding a second
  cross-machine fan-out for the same underlying data would duplicate a surface rather than serve
  one. A pool view of counters is a follow-up if it is ever wanted, not a gap this change creates.
- **It does not audit the wider class.** This is one instance of "a spec nominates rollout
  evidence that was never built". Whether other `rollout-evidence-ref` values resolve is an
  open question this change does not answer. <!-- tracked: ACT-1394 -->

## 3. Level-of-abstraction fit

Correct layer, and deliberately the *thinnest* one. `stats()` already existed with the right
shape; this exposes it and adds nothing else. The alternative — computing counters in the route —
would have created a second source of truth for numbers the verifier already maintains.

The spec-ref correction belongs in the same change because a stats route at a path the spec does
not name would leave the rollout check just as unevaluable as before, only less obviously.

## 4. Signal vs authority compliance

Pure signal, and structurally incapable of being anything else: a GET that reads a counters
snapshot. It gates nothing, blocks nothing, and mutates nothing. `stats()` returns a deep copy
(`JSON.parse(JSON.stringify(...))`), so a caller cannot reach through the response into live
counters. A test asserts the route touches no mutation entry point — `recordDisposition` and
`recordCanaryDrift` throw if called during the request.

## 5. Interactions

- **Sibling route.** Shares the 503-when-absent contract with `/completion-claim/audit`; no
  shared state, no ordering dependency, and reading stats does not disturb the audit ring.
- **Rollout tracking.** The corrected `rollout-evidence-ref` is what the rollout machinery reads.
  Before this change it pointed at a 404, so any automated evidence check would have failed or
  silently found nothing; after it, the check resolves.
- **Metric naming.** The response carries both `stats.classifiedTurns` (the internal field) and
  `classified-completion-claims` (the spec's name) so a rollout check does not need to know the
  internal field name. Duplication is deliberate and one-directional — the spec name mirrors the
  counter, never the reverse.

## 6. External surfaces

One new authenticated GET. No wire-format change to any existing route, no schema, no migration,
no config, no persisted state. The only non-route change is a single frontmatter line in a spec.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so — no durable state is introduced.** The counters
describe what *this* server process has observed; they are in-memory, per-process, and reset on
restart, which is a property of the existing verifier and not something this change alters. There
is nothing here to replicate: a peer's counters are a different fact about a different process,
not a stale copy of the same fact. `scope: 'local'` is stated explicitly in the response so a
reader never mistakes it for a pool figure, and the pool projection continues to live on the audit
route where the underlying records are durable.

## 8. Rollback cost

Delete the route and revert one frontmatter line. Nothing persists, nothing migrates, no consumer
exists yet that could break. The feature returns to exactly its present state: running, observing,
and unable to graduate.

## Evidence

Tests verified to fail against unmodified source before the fix was applied:

```
# route reverted
Tests  5 failed (5)
  ✗ 503s when the verifier is absent
  ✗ returns the raw counters when present
  ✗ surfaces the spec's graduation metric name
  ✗ reports zero honestly rather than omitting the metric
  ✗ is read-only

# route applied
Tests  5 passed (5)
tsc --noEmit — clean
```

The "reports zero honestly" case is the one worth keeping: a dark feature that has classified
nothing must read as `0`, never as an absent field, because absent is indistinguishable from
"the endpoint does not work" — which is precisely the condition this route exists to end.
