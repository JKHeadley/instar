# Side-Effects Review — Durable-Output Hygiene Standard (Layer B scrub, defect class 4)

**Version / slug:** `durable-output-hygiene-standard`
**Date:** `2026-07-03`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required (tier 2; dark-first, dryRun-defaulted content transform — no allow/deny gate surface)`

## Summary of the change

Implements the converged + approved spec `docs/specs/durable-output-hygiene-standard.md`
(INSTAR-Bench v2 defect class 4: a session-digest writer reproduced a live access token
verbatim into stored memory). Ships the Layer-B deterministic security floor: a shared
credential-pattern module (`src/core/durableSecretScrub.ts` — `scrubForStore` /
`scrubStructured`, metadata-returning, fail-safe-toward-redaction, size-bounded, linear
patterns only) wrapped by the config-gated `src/monitoring/DurableOutputScrubber.ts`
(enabled via the developmentAgent dark-gate, dryRun defaults TRUE, FeatureMetricsLedger
counters under `durable-output-scrub`, per-store poisoning alarm), wired at the FIRST
chokepoint — `src/messaging/SessionSummarySentinel.ts` `saveSummary` (fields task/
blockers/files/topics; mandatory `redactionNote` provenance on any altered summary).
The auditable chokepoint inventory (`src/data/durableOutputChokepoints.ts`) + a
shrink-only ratchet test pin every other known store as `pending`/`exempt` with owners.
Config: `monitoring.durableOutputScrub` in ConfigDefaults (enabled OMITTED — dev-gate;
`dryRun: true`; `perStore: {}`); registered in `DEV_GATED_FEATURES` and in
`guardManifest` (configPath + dryRunConfigPath, event-driven, no tick). Server boot
wiring in `src/commands/server.ts` (scrubber construction, metrics sink, poisoning →
one deduped attention item per store). Types in `src/core/types.ts`. Tests: unit ×3
(floor, scrubber, chokepoint ratchet) + integration ×1 (SessionSummarySentinel write
path), 32 tests.

## Decision-point inventory

- `SessionSummarySentinel.saveSummary → scrubForStore` — add — a content TRANSFORM at
  the persistence write (never a block: a scrubbed write still lands). Strict no-op
  when the scrubber is absent or not engaged (dark), original-text passthrough in
  dryRun.
- `DurableOutputScrubber.scrub / scrubRecord` — add — the gating layer: enabled
  (dev-gate) × dryRun (default TRUE) decide whether the computed redaction is applied
  or only counted. Fail-safe: dryRun is `config.dryRun !== false`, so a missing flag
  can never silently enable real redaction.
- `durableSecretScrub.scrubForStore` — add — pure deterministic floor; on scrub
  exception or oversize input the FIELD is withheld under a typed marker
  (`[REDACTED:scrub-error]` / `[REDACTED:oversize]`) — raw bytes never land because
  the scrub broke, and the event is counted (never fail-open, never silent loss).
- `Poisoning alarm (onPoisoningSuspected → createAttentionItem)` — add — signal-only
  escalation, one deduped attention item per store (stable id
  `durable-output-poisoning:<store>`); the AttentionTopicGuard flood ceiling backstops.
- `Chokepoint ratchet (tests/unit/durable-output-chokepoint-ratchet.test.ts)` — add —
  CI-side: statuses may only graduate pending→wired, never regress; a new durable
  persistence path must classify itself in the inventory.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is rejected — the scrub is a content transform, never a block; every write
still lands. The over-ACTION risk is a FALSE-POSITIVE redaction destroying a
legitimate span (the known FP suspect: the JWT-shaped pattern on dotted identifiers).
That risk is exactly why dryRun defaults TRUE and the dryRun:false flip is the
operator's endpoint decision on the measured soak packet (spec Frontloaded Decision
#4: ≥25 reviewed would-redact events with zero FPs, or ≥14 days AND ≥10 reviewed).
While dark/dryRun (the shipped state) the worst case is a spurious would-redact
counter — no content is altered.

---

## 2. Under-block

**What failure modes does this still miss?**

- The floor catches KNOWN TOKEN SHAPES ONLY (stated normatively in the spec/standard
  text): encoded, split, or paraphrased secrets pass the regex floor — Layer A (the
  prompt clause, a separate rollout step) is the only layer that can catch those, and
  it is best-effort.
- Only the session-summary chokepoint is WIRED in this change; the other inventoried
  stores (self-knowledge facts, KB synthesizer, correction distiller, cartographer
  summaries, learnings + their replicated-receive paths) are `pending` with owners,
  pinned shrink-only by the ratchet so they cannot silently stay unwired.
- A secret that only PARTIALLY matches a pattern leaves a residual fragment
  (span-replacement, documented + accepted in the spec; mitigated by Layer A + the
  planted-secret bench axis).

---

## 3. Level-of-abstraction fit

Right layer: a deterministic, cheap, pattern-based DETECTOR-plus-floor at the
persistence write — deliberately NOT an LLM gate (LLM compliance is probabilistic; the
floor is not). It does not re-implement an existing primitive: the ≥3 diverged inline
scrub copies (`autonomousHeartbeatScrub`, PolicyEnforcementLayer patterns,
`SecretRedactor.BUILTIN_PATTERNS`) are the drift problem the shared module exists to
close; they migrate onto it per the spec's rollout step 0 (tracked in the inventory,
not silently duplicated). It FEEDS existing surfaces (FeatureMetricsLedger, attention
queue, /guards via guardManifest) instead of growing parallel ones.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — but sanctioned: this is a detector holding MUTATION authority over durable
  content, classified per the spec (§Decision points touched) as a **sanctioned
  deterministic safety floor** (the fork-bomb spawn-cap precedent), carrying the
  bypass-carries-its-own-cap preconditions: dark-first, dryRun-defaulted soak with
  measured FP rate, MANDATORY provenance marker on every alteration (no silent
  mutation), typed markers + structured kind/offset/length metadata, per-store opt-out
  (`perStore` in config + `exempt` in the inventory), operator-gated enforce flip.
- It has NO block/allow surface — a write is never refused, only (eventually,
  post-operator-flip) span-redacted with a visible marker.

---

## 5. Interactions

- **Shadowing:** the scrub runs INSIDE `saveSummary` on the fresh-generate path only;
  the staleness re-save path deliberately re-persists the already-scrubbed summary
  (re-scrubbing would recompute an empty provenance and drop `redactionNote`). It does
  not run before/after any existing allow/deny check — none exists on this write.
- **Double-fire:** the existing telemetry scrubs (heartbeat scrub, PolicyEnforcementLayer)
  cover DIFFERENT surfaces (outbound messages, logs); no store is scrubbed twice. The
  poisoning alarm dedupes per store id; the AttentionTopicGuard is the flood backstop.
- **Races:** the scrubber is constructed once at boot and is stateless per call except
  the in-memory poisoning window (single process, no shared file state) — no new
  cross-process state.
- **Feedback loops:** metrics/alarm consumers never feed back into the scrub decision;
  a metrics-sink or alarm-callback throw is swallowed (tagged @silent-fallback-ok) so
  observability can never break the persist path.

---

## 6. External surfaces

- Other agents / install base: none while dark (fleet resolves the dev-gate to OFF;
  behavior byte-identical to today). On a dev agent, dryRun TRUE means stored bytes
  are still unchanged — only metrics rows + (if a burst) one attention item appear.
- External systems: none — pure local regex, no LLM call, no spawn-cap slot, no
  egress, no third-party spend.
- Persistent state: adds the optional `redactionNote` field on persisted
  SessionSummary records (additive JSON field, old readers unaffected) — and only
  post-operator-flip.
- **Operator surface (Mobile-Complete Operator Actions):** no new operator-facing
  ACTION in this change. The eventual dryRun:false flip is a config decision made on
  an attention-queue decision packet (readable from the phone); no PIN route or form
  is added here.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard renderer/approval page/grant form
touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Declared: machine-local execution over git/code-replicated config, with the
replicated-store RECEIVE paths named as their own chokepoints.** The scrub runs where
the write runs; the inventory + config replicate via code. The spec (§3) names the
real multi-machine hazard — a peer running with the scrub dark writes an unscrubbed
secret that replication delivers into a scrub-enabled machine's store, bypassing
writer-side chokepoints — and the inventory therefore lists each replicated store's
receive path as its own chokepoint (`receivePath`, scrub-on-receive on the LOCAL
materialized copy only, never what re-replicates; identity fingerprints computed with
redaction markers normalized out; redaction metadata merge-inert). Those receive-path
wirings are `pending` entries pinned by the ratchet. No user-facing notices (one-voice
n/a — the poisoning alarm rides the existing attention queue, which is pool-coalesced
via P17); no URLs generated; the only durable state is the store content itself, which
already has an owner machine.

---

## 8. Rollback cost

Pure code + config change, shipped dark. Rollback = revert the commit and ship a
patch. No data migration: while dark/dryRun NO stored bytes differ; post-flip, altered
records carry `redactionNote` + typed markers (the original span is destroyed BY
DESIGN — that irreversibility is why the flip is operator-gated, and it is a property
of the feature, not of rolling it back). No agent state repair; no user-visible
regression during a rollback window.

---

## Conclusion

The review confirmed the shipped state is inert on the fleet (dev-gate OFF), metrics-
only on the dev agent (dryRun TRUE, fail-safe default `!== false`), and that every
failure path fails toward redaction/withholding rather than leaking (scrub-error /
oversize withhold the field under a typed marker; metrics/alarm throws never break the
write). One design point was tightened during the finish pass: the scrub was
registered in `guardManifest` with `dryRunConfigPath` so /guards, the boot tripwire,
and the dark-but-load-bearing classifier cover the posture from day one. Clear to
ship dark; the enforce flip remains the operator's decision on the soak packet.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: not required** — tier 2, no allow/deny gate
surface, dark-first + dryRun-defaulted; the operator-gated flip is the human check
on the only destructive transition.

---

## Evidence pointers

- Bounded test runs (2026-07-03): `tests/unit/durableSecretScrub.test.ts` (12),
  `tests/unit/DurableOutputScrubber.test.ts` (10),
  `tests/unit/durable-output-chokepoint-ratchet.test.ts` (6),
  `tests/integration/session-summary-durable-scrub.test.ts` (4) — all pass.
- Ratchet/lint verification: `tests/unit/lint-dev-agent-dark-gate.test.ts` (24, golden
  map regenerated via `attributeEnabledFalsePaths` over the rebased ConfigDefaults),
  `tests/unit/no-silent-fallbacks.test.ts` (back at baseline),
  `tests/unit/lint-guard-manifest.test.ts` (14),
  `tests/unit/feature-delivery-completeness.test.ts` + `tests/unit/CapabilityIndex.test.ts`
  (125), guard-posture-view (52) — all pass. `tsc --noEmit` clean;
  `scripts/docs-coverage.mjs` floors green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect fixed in THIS commit — not applicable. (This change
BUILDS the class-4 guard machinery per the spec; the defect-class closure itself is
graded by the Standards Enforcement Coverage audit over the chokepoint inventory once
the registry text ships, which remains operator-gated.)
