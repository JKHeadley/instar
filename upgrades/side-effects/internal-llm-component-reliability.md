# Side-Effects Review — Internal LLM component reliability

**Version / slug:** `internal-llm-component-reliability`
**Date:** `2026-07-28`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds component-level LLM error rates and reliability status to
`FeatureMetricsLedger`, feeds that snapshot into `/health`, and corrects timeout
or queue semantics at three measured failure sites. The runtime files are
`FeatureMetricsLedger.ts`, `routes.ts`, `ProfileIntentClassifier.ts`,
`ClaimClauseArbiter.ts`, `TopicIntentExtractor.ts`, and the profile default in
`commands/server.ts`. It changes health classification but does not add an
action, message, or deletion authority.

## Decision-point inventory

- `/health` status — modify — a component with at least 20 real LLM calls and
  at least 20% errors now makes health degraded; at 50% it is named failing.
- Profile-intent classifier execution — pass-through — the existing LLM and
  enum/confidence/grounding authority is unchanged; only its attempt and total
  execution budgets are separated.
- Completion and topic-intent observation — pass-through — verdict semantics
  are unchanged; only timeout and queue participation are corrected.

---

## 1. Over-block

No block/allow surface. The new threshold can mark health degraded for an
intentionally experimental component after 20 calls, but it cannot reject or
hold an input. The response carries the exact denominator and severity so that
an operator can distinguish a small sample from sustained high volume.

---

## 2. Under-block

The snapshot does not alert below 20 real LLM calls, so a low-volume component
can fail repeatedly without changing health until it reaches that sample floor.
It also does not diagnose the cause; it names the component and measured rate.
Provider successes whose result is abandoned by a higher caller deadline remain
successes at this ledger layer unless that caller records its own outcome.

---

## 3. Level-of-abstraction fit

The per-component calculation belongs beside the canonical per-feature rollup:
it reuses one already-materialized window and does not add a second metrics
store or scanner. `/health` is the correct consumer because it already owns the
human-facing process-health status. Timeout changes stay at the call sites
whose workload semantics are known; no shared resolver or global provider
default changes.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The deterministic thresholds produce a health signal. They do not block an
action or trigger remediation. Existing LLM authorities continue to make their
own contextual decisions with unchanged prompts and output contracts.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The thresholds
classify a measured ratio with a fixed sample floor; they do not choose between
competing live signals or decide user intent.

---

## 5. Interactions

- **Shadowing:** the new snapshot is additive to session, scheduler, and recent
  degradation health. Any one can degrade the route; none suppresses another.
- **Double-fire:** no events or alerts are emitted. Repeated health reads are
  read-only.
- **Races:** the ledger's existing synchronous summary supplies one coherent
  read window. No mutable cache or timer is added.
- **Feedback loops:** no automatic retry or routing change consumes the health
  status. Timeout changes may reduce error rows, which is the intended measured
  feedback after rollout.
- **Queue interaction:** completion verification was already behind bounded
  admission and metering queues. Removing `deferrable` prevents the router from
  enqueueing the same call again after a failed swap.

---

## 6. External surfaces

`/metrics/features` gains `errorRate`, `unclassified`, and
`fireRateInsufficientEvidence` fields plus a `reliability` object. `errorRate`
and `fireRate` are now nullable when their denominators are absent.
`/health` gains `llmReliability` when the ledger exists and may now correctly
report `degraded` for a component outage. A one-time local metrics migration
conservatively changes legacy LLM `noop` rows to `unclassified`; the old
encoding cannot establish that a verdict classifier ran. Call counts, tokens,
latency, and correlation ids are unchanged. No external service call or
operator-facing action is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval page, or operator form is changed. The health
JSON names human-readable component, status, errors, and real-call denominator;
it does not make a raw identifier the primary content.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Internal provider reachability, framework
availability, and latency can differ by machine, so each machine's `/health`
must report its own component reliability rather than replicate or merge it
into a misleading fleet average. The change emits no user-facing notice, holds
no new durable state, and generates no URL. Topic transfer strands nothing.

---

## 8. Rollback cost

Pure code and derived-response change. Revert and ship a patch. There is no
schema migration, state repair, or cleanup. During rollback propagation the
old health route may again hide a component outage behind aggregate traffic,
but no stored data is lost.

---

## Conclusion

The review kept the correction at the measured call sites instead of changing
the shared path resolver, global provider timeouts, or routing policy. The
result reduces two avoidable timeout/queue failures, restores the profile
fallback budget, and makes every residual component outage visible with its
denominator. Clear to ship for review.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

The change does not touch a sentinel, guard, gate authority, session lifecycle,
or message block/allow decision.

---

## Evidence pointers

- `tests/unit/FeatureMetricsLedger.test.ts`
- `tests/integration/metrics-features-routes.test.ts`
- `tests/unit/ProfileIntentClassifier.test.ts`
- `tests/unit/turn-evidence-completion-verifier.test.ts`
- `tests/unit/TopicIntent-capture-extractFn.test.ts`
- `tests/e2e/internal-llm-component-reliability-lifecycle.test.ts`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
