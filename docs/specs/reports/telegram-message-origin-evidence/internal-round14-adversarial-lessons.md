# Round 14 — adversarial and lessons-aware review

Fresh second targeted pass on unchanged body `0cf9f5ebddf6917de2e748ea4a78081958572c3f96c518275fb0f2b9a1643c4a`. Focus: observability across attribution, actual delivery and outage/restart failure, rather than repeating the round-13 restart review. Both perspectives are from the same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0.**

Attempted false-green cases: an always-unknown model adapter, HTTP-200 suppression presented as delivery, a missing receipt after dispatch, stale-origin redrive, missing peer audit data, and restart losing the notice permit and readable held-work count. The spec requires distinct evidence statuses, positive model controls, explicit suppressed/outcome-unknown states, immutable original provenance, incomplete shard coverage and unavailable—not fabricated zero/success—restart health. The relevant observability is tied to those states rather than inferred from a successful endpoint or an origin row alone.

The private audit scope still protects direct IDs, filters, counts and cursor coverage. More observability does not license broader session credentials. No newly discovered bypass or design defect.

## LESSONS-AWARE: explicit Observability flag adjudication

**DESIGN: 0. PRECISION: 0.**

Read the full Observability article in `docs/STANDARDS-REGISTRY.md:538`, including its whole-loop requirement and prohibition on capture-only metering. Conformance round 14 checked 90 standards without degradation and raised a possible violation claiming the feature lacks metrics that make effectiveness auditable and gradable. That broad absence claim is not supported by the current contracts:

- Attribution quality: contract 2 requires health counts by observed/configured/unknown and harness, degraded attribution, and a positive control that rejects an always-unknown implementation.
- Downstream delivery: the append-only attempt schema includes origin/child/attempt identity, transport, state, timestamps and concrete receipt identity. Contracts 5–8 distinguish admission, suppression, known failure, acceptance, scheduling, partial delivery and uncertainty; contract 11 retains expired-unresolved outcomes. The scoped audit read surface makes these records inspectable beyond preparation alone. This is the data needed to grade completion and uncertainty across the loop, not merely count captured origins.
- Outage effectiveness: live health exposes held work, notificationAttempted and notificationOutcome, including unavailable/suppressed coverage. It broadcasts changes and persists events/receipts after recovery. Acceptance 18 requires honest unknown/unavailable state after restart rather than manufactured zeroes.
- Measurement coverage: pool cursors disclose missing shards; archive retention preserves the evidence; the sender denominator and activation matrix require every contract/sub-obligation to map to passing tests and real wiring. The matrix is verification of runtime-observability wiring, **not itself runtime telemetry**.

I therefore do not adopt the possible violation as a new defect. This conclusion depends on implementing the named read surfaces and outcome fields; it is not a claim that those metrics exist in deployed code. The spec does not name a separate derived KPI dashboard or telemetry product, and adding one is not necessary to remedy an identified missing stage. Existing mandatory model counts plus inspectable lifecycle/outage records already permit effectiveness assessment. The diagnostic consult remains in the existing bounded LLM queue and its output is recorded for the existing recovery consumer, without gaining execution authority.

## Counts and scope

Combined: **0 DESIGN, 0 PRECISION**. Round-14 conformance flag retained and reasoned about above, not deleted or ignored. No previous or independent external finding was reclassified. These internal reviews alone do not establish aggregate convergence. No code/runtime edits or external sends performed.
