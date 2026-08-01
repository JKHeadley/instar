# Side-Effects Review — Instrument semantic liveness

**Version / slug:** `instrument-semantic-liveness`
**Date:** `2026-08-01`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds a validated, opt-in assessment report for script instruments,
preserves it in job state, repairs script retry convergence, and changes
alignment scoring to use one measurable cohort with explicit population and
exclusion counts. Echo's agent-local delivery canary now treats transport
unavailability as an exclusion instead of a delivery-contract finding. The
runtime files are `src/core/InstrumentAssessment.ts`,
`src/scheduler/JobScheduler.ts`, `src/core/IntentDriftDetector.ts`,
`src/core/types.ts`, `src/commands/intent.ts`, and `src/index.ts`.

## Decision-point inventory

- `parseInstrumentAssessment` — add — validates a source-owned observability
  report as a hard structural invariant; it holds no operational authority.
- `JobScheduler.runScriptJob` — modify — preserves a valid source report from
  stdout or stderr without inferring one from process status.
- `JobScheduler.triggerJob` — modify — preserves retry state on retry triggers
  and clears it only for a new episode or successful completion.
- `JobScheduler.runScriptJob` — modify — preserves the durable consecutive-
  failure streak while an attempt is pending and resets it only after success.
- `IntentDriftDetector.alignmentScore` — modify — builds one valid-confidence
  cohort and publishes population, exclusions, and coverage.
- `instar intent drift` — modify — renders cohort coverage for assessed grades.
- Echo's `delivery-canary.mjs` — modify outside the product repository —
  unavailable peers lower coverage, while only measured typed-contract
  violations create findings and a nonzero exit.

---

## 1. Over-block

The assessment parser is strict only for scripts that emit its exact marker.
Ordinary output, including a constant zero-conflict result, is ignored. A
source that opts in but emits impossible totals, mismatched coverage, an
assessed `none`, or an unassessable pass/fail is rejected as malformed. This is
structural validation of an explicit machine contract, not a judgment about
the source's prose or meaning.

Alignment does not reject input. Rows whose confidence is missing or cannot be
interpreted numerically remain in the published population and exclusion
counts, but are not used in the composite score.

---

## 2. Under-block

The report contract cannot prove that a source's reason is semantically true;
a buggy or dishonest source may still report internally consistent counts.
That is intentionally outside the generic parser's authority. Per-source tests
and negative controls remain responsible for proving that relevant world
states can influence the source's report.

A persistently unavailable peer no longer produces a delivery-contract alert
from this canary. Peer reachability remains owned by the existing rope and
health surfaces. A reachable typed but unexpected mesh response remains a hard
canary finding.

---

## 3. Level-of-abstraction fit

The contract sits at the source/scheduler boundary: each source knows what it
attempted to measure, while the scheduler owns generic validation and durable
preservation. A central constancy detector would operate at the wrong layer
because it could not distinguish a healthy stable negative-control surface
from a collapsed instrument. Alignment cohort construction stays inside the
alignment scorer, which owns the composite's denominator semantics. Retry
episode convergence stays inside the scheduler, which owns timers and retry
state.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no judgment-level block/allow surface.

The parser may refuse a malformed opt-in report, which is hard-invariant
validation explicitly permitted by the principle. It does not block script
execution, infer semantic darkness, or convert repeated output into authority.
The canary source retains authority only over its own typed protocol contract:
unmeasured transport states are excluded, not called pass or fail.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point.
Availability-versus-conformance is made enumerable by the typed response
boundary: typed mesh responses are measured, while transport failures and
untyped edge responses are explicitly unassessable. Alignment uses a structural
numeric-cohort invariant rather than choosing among conflicting behavioral
signals.

---

## 5. Interactions

- **Shadowing:** `lastAssessment` is additive beside `lastResult`; it does not
  replace process success/failure. Consumers must read the assessment when they
  need measurement status rather than inferring a verdict from process status.
- **Double-fire:** the canary no longer alerts for peer unavailability, avoiding
  overlap with rope/peer availability owners. It still alerts once for measured
  protocol violations.
- **Races:** retry state is episode-scoped. A retry callback retains its count;
  a fresh cron or explicit trigger starts a new bounded episode; success clears
  the state. Existing active-job checks still prevent concurrent execution.
- **Feedback loops:** a failed script reaches the existing six-delay ceiling and
  settles until the next cron window. It can no longer reset itself to a one-
  minute retry indefinitely. A cron arriving later starts one new bounded
  episode as designed.

---

## 6. External surfaces

`GET /intent/alignment` adds `populationSize`, `excludedSampleSize`,
`exclusions`, and `sampleCoverage`. Its `sampleSize` is clarified from all rows
to the common cohort actually scored. Job-state surfaces may add
`lastAssessment`. Existing journal rows remain unchanged and scripts without
the marker protocol retain their prior behavior. The live Echo canary is an
agent-local consumer and has already been verified against an unavailable peer.

No new operator action, external write authority, URL, configuration setting,
or timer is introduced. The canary's existing Telegram alert path remains
available for measured failures and now receives its vault-backed credential
in scheduler execution.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval page, grant/revoke flow, secret form, or other
operator surface is changed. No operator-facing action is added; not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** assessment state describes the machine that ran a
particular scheduled job. The delivery canary measures its local registry arm
and each registered peer arm separately, so a second machine changes the
population and coverage instead of producing duplicate conformance claims.
Peer availability is not promoted into protocol authority.

This change emits a user-facing notice only for a measured delivery-contract
violation through the existing canary alert path; it adds no new one-voice
mechanism. It adds only optional job-state fields, creates no new durable store,
does not strand topic-owned state on transfer, and generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the runtime changes and ship the next patch.
- **Data migration:** none. Existing JSON readers tolerate the additive
  `lastAssessment` field, and no journal rows are rewritten.
- **Agent state repair:** none required. Old runtimes ignore the additive field.
- **User visibility:** rollback would restore the old N/A alignment behavior
  and the old noisy canary behavior while the patch propagates, but would not
  corrupt state.

---

## Conclusion

The review confirmed that semantic assessment must remain source-reported and
that no run-count or constancy heuristic can hold authority. It also separated
transport availability from typed protocol conformance and made retry
settlement explicit. The change is reversible, migration-free, and clear to
ship with the documented residual risk that a source can still make a
semantically wrong but structurally valid claim.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

The change does not alter messaging block/allow decisions, dispatch authority,
session spawn/restart/kill/recovery, compaction, trust, or a sentinel/guard/gate/
watchdog. Its autonomous retry controller is covered by the existing
self-action convergence ratchet and the machine-readable closure declaration.

---

## Evidence pointers

- `tests/unit/InstrumentAssessment.test.ts`
- `tests/unit/JobScheduler-script-job.test.ts`
- `tests/unit/job-retry.test.ts`
- `tests/unit/alignment-score-not-assessed.test.ts`
- `tests/unit/IntentDriftDetector.test.ts`
- Focused verification after the annotation fix: 65 tests passed.
- Repository-wide run: 47,242 tests passed; 18 unrelated environment-sensitive
  failures in spawn, Gemini credential, and slow end-to-end lanes.
- TypeScript check, full lint, production build, and diff checks passed.
- Live Echo alignment: 10 of 40 rows measurable, 30 excluded, assessed grade C.
- Live Echo delivery canary: HTTP 530 excluded as unavailable, one of two arms
  measured, no finding, exit zero.

---

## Class-Closure Declaration (display-only mirror)

For the instrument defect: `defectClass: novel`, `closure: gap`, `gapItem:
ACT-378`, `component: instrument-observability`. The new registry class is
`instrument-semantic-darkness`, nearest to
`aggregate-masks-subgroup-regression`; it includes collapsed availability and
conformance states, legacy invalid rows that prevent valid new input from
repairing a bounded metric, and verdicts that hide their cohort. It excludes a
constant surface that would react to relevant input, an instrument that simply
has not seen variety, and an explicitly unassessable run that future input can
repair. The candidate tests cannot claim guard closure until the operator
confirms the novel class; ACT-378 tracks that gap.

For the independent scheduler controller: `defectClass:
unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType:
ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the
retry edge carries its episode counter through all six delays; the sixth retry
exhausts the episode and leaves no timer, which proves a steady-state bound and
settling brake under sustained script failure }`.
