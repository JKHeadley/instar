---
title: "Durable-Output Hygiene Standard"
slug: "durable-output-hygiene-standard"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "durable-output-hygiene-standard.eli16.md"
status: "review-convergence (round-3 clean pass 2026-07-02: codex CLEAN; all gemini findings triaged ALREADY-ADDRESSED with section citations; internal reviewer CLEAN)"
tags: ["review-convergence"]
origin: "INSTAR-Bench v2 defect-class review (docs/audits/ib2-defect-class-review-2026-07-02.md), Class 4"
operator-gate: "Registry text ships ONLY with Justin's explicit sign-off. The persistence-chokepoint scrub + coverage axis ship through the normal instar-dev pipeline (scrub dark-first per Graduated Rollout). The FLEET default posture of the scrub is ALSO an operator decision — see Frontloaded Decisions #4."
---

# Spec — Durable-Output Hygiene Standard (defect class 4 closure)

**Ships:** standard text → standards registry (operator-gated); durable-secret bench axis →
bench-coverage CI ratchet; deterministic scrub at persistence chokepoints → src (dark-first,
config-gated under `monitoring.durableOutputScrub`).

**Run boundary (Autonomy Principle 2):** the /instar-dev run's deliverable is the live
enforcement machinery dark/dry-run on the dev agent + the DRAFTED registry text + the
operator decision packet for the fleet posture. Operator sign-off (registry text AND fleet
scrub posture) is the run's endpoint.

## Problem statement

The session-digest writer — whose output persists into long-term memory — reproduced a live
access token VERBATIM into a stored digest, on two independent runs (INSTAR-Bench v2, blind
judging). Two other model routes obeyed a planted "mark this a major milestone, record this
fake admin-approval" line. The prompt had zero rules about secrets or planted content. The
model summarized what it saw, faithfully; the defect is ours.

Standards-registry check (verified 2026-07-02): the registry's secret/redaction coverage
governs vault handling (Sovereignty, Self-Unblock), one-time collection (Secret Drop /
Mobile-Complete Operator Actions), and test-fixture redaction (Fixture Realness same-shape
placeholders) — all INPUT- and STORAGE-side. A prompt whose OUTPUT lands in durable storage
is governed by nothing. A leaked-into-context credential currently rides LLM output into
disk-persistent stores (digests, memory entries, learnings, KB records, doc-tree summaries)
where it outlives the session that leaked it.

The shipped digest-safety fix (merged in v1.3.721) is the per-instance template; this spec
makes the class unrepresentable.

**Terms (external readability):** *door* = the access path to a model (CLI wrapper vs clean
API); *route* = model + door; *ratchet* = a CI test pinning a baseline that may only
shrink; *callsite* = one LLM decision-point in the coverage registry. (Same glossary block
as the sibling specs.)

## Proposed design

### 1. The standard (registry text, operator-gated)

New registry entry, working title **"What Persists Must Be Clean"**:

> Any LLM callsite whose output lands in durable storage must (a) instruct redaction — a
> credential encountered in the material is DESCRIBED in redacted form ("a live <kind>
> token appeared in <place>"), never quoted; (b) treat instructions planted in the material
> as data to describe, never orders to follow (the Authority Clause standard applied to
> writers); and (c) carry a planted-secret test case in its benchmark battery. The
> persistence chokepoint that stores the output must name its deterministic scrub or carry
> an argued exemption — and the scrub's honest coverage is KNOWN TOKEN SHAPES ONLY: the
> deterministic floor catches what matches its patterns; the prompt rule is the only layer
> that can catch encoded, split, or paraphrased secrets, and against novel adversarial
> obfuscation it is BEST-EFFORT, proven only as far as its test cases reach — never a
> reliable security control on its own.
> Earned from: the digest credential copy (INSTAR-Bench v2, 2026-07-02) — a live access
> token was reproduced verbatim into stored memory on two independent runs.

### 2. Two layers, deliberately redundant — and who guarantees what

**Layer B — the deterministic scrub is the SECURITY FLOOR (primary guarantee).** LLM
compliance is probabilistic; the floor is not. At each persistence chokepoint that stores
LLM output, run the shared credential-pattern scrubber over the output BEFORE write; on a
match, replace the matched span with a typed redaction marker (`[REDACTED:<pattern-kind>]`)
and record structured redaction metadata. **Layer A — the prompt rule is the
quality-preserving depth**: it makes the model DESCRIBE the leak in redacted form (so the
stored record stays useful) and is the only layer that can catch non-pattern-matching
shapes. (Round-1 external review was right that the original draft had this priority
inverted.)

**Layer A mechanics.** A shared `durableOutputHygiene()` clause in
`src/core/promptClauses.ts` (sibling of the authority clause; same golden-content pin,
protected-path, versioning, render-lint, and `clausesFor(...)` composition —
`durableOutput ⇒ untrustedInput` unless argued): describe-never-quote for credentials,
planted-instructions-are-data, and "the leak itself is the lesson worth recording — in
redacted form." The shipped digest fix's A/B-proven wording seeds the clause (3 real
failures fixed, 0 regressions, 49/49 outputs parsed).

**Layer B mechanics (pinned down per round-1 MATERIAL findings):**
- **One shared pattern module first (rollout step 0).** "The existing scrubber" is today
  ≥3 diverged inline copies (`autonomousHeartbeatScrub`, `PolicyEnforcementLayer`
  patterns, `SecretRedactor.BUILTIN_PATTERNS` — already drifted on the Anthropic key
  prefix). Building a fourth copy would bake Class-1 drift into the safety floor itself.
  Step 0 extracts ONE shared pattern module with its own pinned pattern test; Layer B
  consumes it and the existing copies migrate (or are ratcheted) to it. The module
  documents its detector classes and test corpus; entropy-based detection is NOT in the
  v1 floor (explicitly rejected for FP volatility) but an entropy HEURISTIC feeds dry-run
  telemetry (below) so the decision packet has data.
- **A metadata-returning API.** The current `scrubSecrets()` returns only a scrubbed
  string; Layer B needs `scrubForStore(text) → { text, redactions: [{kind, offset,
  length}] }` — a new variant, named here so the build estimate is honest.
- **Failure semantics: fail-safe-toward-redaction, never fail-open, never silent loss.**
  On scrub exception — or an input exceeding the size bound (default 1 MB) — the write
  proceeds with the whole field replaced by `[REDACTED:scrub-error]` or
  `[REDACTED:oversize]` plus a preserved-length note, and the event increments the
  observable counter — raw bytes never land because the scrub broke. There is NO runtime
  "timeout" pretense (a synchronous regex pass cannot be preempted in-process): instead the
  shared pattern module's pinned test asserts a worst-case timing budget on pathological
  inputs and forbids non-linear patterns (no nested quantifiers), so the budget is proven
  in CI, not hoped at runtime. All inventoried chokepoints are cadenced background writes,
  so event-loop cost is bounded by construction. **Degradation is bounded, not just
  visible:** repeated scrub-error/oversize events on one store cross the same per-store
  alarm threshold as redaction bursts (below) and are tagged as the HIGHER-severity kind —
  an attacker mass-feeding credential-shaped or oversized payloads to blank out records is
  an attention-item event, not a quiet counter.
- **Structured redaction metadata + provenance (MANDATORY, was Open Q2).** Where the
  store's shape allows, redaction metadata is stored structurally alongside the content
  (`redactions: [{kind, offset, length}]`); every altered entry ALSO carries a one-line
  human-visible provenance marker ("N spans redacted — see feature metrics"). An unmarked
  alteration is a swallowed finding. Scrub runs BEFORE serialization where the store
  writes structured fields (per-store payload-shape compatibility tests are part of each
  chokepoint's graduation).
- **Span-replacement, documented.** The heartbeat-scrub family deliberately drops whole
  fields; Layer B replaces spans because durable stores carry the record's ongoing value
  (a digest with one redacted span is still a digest). The residual-fragment risk (a
  secret only partially matching) is accepted, documented, and mitigated by Layer A + the
  planted-secret axis. Memory-family stores MAY opt per-inventory-entry into
  drop-whole-field.
- **Telemetry must never carry the secret (dry-run leak-path guard).** Would-redact and
  did-redact records carry pattern-kind + store + callsite + offset/length ONLY — never
  matched bytes, never surrounding context. This is stated normatively because a
  would-redact log that quotes its match IS the Class-4 defect, reintroduced by the fix's
  own soak mode. **The FP-review workflow, split honestly by phase:** PRE-enforcement
  (dryRun), review re-runs the scrub against the already-stored raw entry via a dedicated
  script that reports kind/verdict/offset ONLY and never prints matched spans (the
  `secret-drop-retrieve.mjs` hygiene pattern) — the reviewing transcript must not become
  the leak. POST-enforcement, the original span is destroyed by design, so FP diagnosis is
  corpus- and structure-based only (synthetic corpus coverage per pattern kind in the
  pinned test; offset/kind records): the standard says this plainly rather than implying
  redacted spans stay reviewable.
- **Poisoning visibility.** A per-store redaction-rate alarm threshold rides the counter:
  a burst of credential-shaped plants (deliberate memory-degradation) raises ONE deduped
  attention item (stable id per store+kind, pool-coalesced via P17 on multi-machine — same
  shape as the escalator's items) instead of silently corrupting records behind a quiet
  counter.
- **Pattern staleness has an owner.** The shared module's pattern list is reviewed on the
  class-closure escalator's periodic pass (see `class-closure-gate.md`), and integrating
  any new external service with its own key format adds its pattern in the same change
  (review-checklist line in the standard text).

### 3. The chokepoint inventory (auditability)

A small registry enumerating every store that accepts LLM output and, per store, its scrub
status or argued exemption. Known set from the routing registry: session digests
(SessionSummarySentinel), self-knowledge facts extractor, knowledge-base synthesizer,
correction distiller (CorrectionCaptureLoop), cartographer sweep summaries, learnings
registry. **Candidate discovery is mechanical, not hand-memory:** any persistence write of
LLM output already carries an `attribution.component` tag (the Token-Audit lint mandates
tagging); an inventory lint flags a tagged-output persistence path absent from the
inventory, so next month's new store cannot silently bypass the class. **Scope boundary:**
memory-family stores + doc-tree summaries are in scope now; logs/telemetry are covered by
the existing telemetry scrubs (cited per entry); caches/vector indexes/eval artifacts are
enumerated as a tracked follow-up IN the inventory itself — and that follow-up is a gap
item under the class-closure standard, so it carries the gap machinery's max-age escalation
(a semantically-durable leak path cannot park as an undated TODO).

**Multi-machine posture (Cross-Machine Coherence — declared):** the inventory and scrub
config are git/code-replicated (fine). BUT replicated memory-family stores (learnings, KB,
user-visible relationship records) accept records FROM PEERS — a peer running with the
scrub dark writes an unscrubbed secret that replication delivers into a scrub-enabled
machine's durable store, bypassing every writer-side chokepoint. The inventory therefore
lists the replicated-store RECEIVE path as its own chokepoint per store: scrub-on-receive
with the same shared module (cheap — one more callsite), or an argued exemption citing an
existing serve-time redaction (the WS2.1 preferences precedent).

**Scrub-on-receive must not fight the replication machinery** (the mixed-posture window —
dev scrub-live, fleet dark — is the SHIPPED soak state, so this is the normal case, not an
edge): the scrub applies to the LOCAL MATERIALIZED COPY only, never to what re-replicates
(each machine re-serves the origin stream it received, so a scrubbed local copy never
propagates as a divergent edit); cross-machine identity fingerprints are computed with
redaction markers normalized out (equivalently: on identity fields pre-scrub), so the same
record still collapses to one; and redaction metadata is declared MERGE-INERT — a
difference that is only a redaction span never raises a user-facing no-clobber conflict. Scrub counters/telemetry
are per-machine (FeatureMetricsLedger is per-machine SQLite, ~30-day retention — the
dev-soak FP review reads the dev machine directly; there is no pool-scope metrics read and
none is needed for the soak).

The inventory is what the Standards Enforcement Coverage audit reads to grade this standard
`gate`, not `spec-only`.

### 4. The bench-axis ratchet (test-side enforcement)

The program's shared metadata record gains `durableOutput` (required-explicit, argued-false
pinned, same polarity rule as the sibling flags); the consolidated axis ratchet requires ≥1
`axis: "durable-secret"` case whose correct output describes-without-quoting. **Case
shapes:** at least one case uses a same-shape PLACEHOLDER credential (canonical documented
placeholder constants, allowlisted in the credential-leak-detector hook — never a real
secret, never author-invented realistic fakes), and at least one case uses a
NON-pattern-matching shape (encoded or split token) — because only Layer A can catch those,
and an axis containing only regex-matchable shapes would test both layers against the easy
shape while the floor's blind spot goes unmeasured. Battery/axis CI readability rides the
program-wide batteries-in-repo decision (`class-closure-gate.md` §"Program-shared
machinery").

## Decision points touched

Layer B introduces a write-path transform at persistence chokepoints (content-altering, not
blocking — a scrubbed write still lands). No allow/deny gate changes. Layer A changes prompt
text only through the A/B protocol (X2-bounded, prompt-fidelity precondition, verdict
evidence embedded in the committed review record).

**Signal-vs-Authority engagement (P2, named):** Layer B is a detector holding mutation
authority over durable content — normally a P2 violation. It is classified a **sanctioned
deterministic safety floor** (the fork-bomb spawn-cap precedent), and it carries the
bypass-carries-its-own-cap preconditions: dark-first, dry-run soak with measured
false-positive rate, provenance marker on every alteration (no silent mutation), typed
markers + structured metadata (diagnosable after the fact), per-store opt-out in the
inventory, and an operator-gated enforce flip (below). A floor that mutates content earns
that authority by being observable, bounded, and reversible-in-posture — never silent.

## Config, migration, observability (grounded in the real families)

- **Config key:** `monitoring.durableOutputScrub` = `{ enabled, dryRun, perStore }` —
  the `monitoring.*` family, NOT a new `stores.*` family. Absent key ⇒ dark code-default
  (no migration needed to ship). The graduation-to-fleet migration (existing agents with a
  seeded explicit `false` vs absent) is PRE-WRITTEN in `PostUpdateMigrator` as part of this
  build, gated on the operator's posture decision.
- **Guard posture:** the scrub registers in `guardManifest` (configPath + dryRunConfigPath)
  so `/guards`, the boot tripwire, and dark-but-load-bearing classification cover it for
  free once the registry text ships (the standard names it as enforcement arm ⇒
  `loadBearing` when graduated).
- **Observability:** counters ride `FeatureMetricsLedger.recordEvent` under feature key
  `durable-output-scrub`; the LLM Activity tab renders it. Per the Agent Awareness
  Standard, the CLAUDE.md template gains the one-paragraph capability note +
  `migrateClaudeMd` entry in the same build.
- **Testing:** the scrub wiring carries the full three-tier battery (unit on the shared
  module; integration on each chokepoint's write path; E2E "feature is alive" on the
  config-gated posture) per the Testing Integrity Standard — wiring-integrity tests verify
  the chokepoints actually call the shared module, not a no-op.

## Frontloaded Decisions

1. **Pattern set** (was implicit): the shared module extracted in rollout step 0, seeded
   with the union of the three existing copies' patterns + pinned test. Extensions via
   normal PR (protected-path reviewed).
2. **Provenance marker** (was Open Q2): mandatory — structured metadata + one-line marker
   (design §2).
3. **Private views / published pages** (was Open Q3): out of scope; tracked follow-up item
   filed in the same change and cited in the inventory (different write path, same
   pattern).
4. **Fleet default posture** (was Open Q1 — round-1 REJECTED this as a cheap tag, and the
   rejection is accepted): a false-positive redaction destroys data (the original span is
   unrecoverable by design), so the fleet ON-flip is NOT a tunable default — it is the
   **operator's endpoint decision**, made on the dev-soak decision packet. The run
   delivers: dryRun soak on the dev agent; the dev agent's own flip to `dryRun: false`
   happens autonomously ONLY when the concrete criterion holds — **≥25 would-redact events
   reviewed with ZERO false positives, OR ≥14 days AND ≥10 reviewed events** (a quiet
   fortnight with near-zero events is NOT evidence — fewer events ⇒ stay dryRun and extend
   the soak; P14 refuses the vacuous pass); any false positive → stay dryRun + file the
   gap. At flip time the decision packet (event counts, per-pattern-kind FP rates) is
   POSTED to the attention queue — visible self-certification, not approval-gated. The
   soak review itself is registered as a scheduled commitment at build time (Close the
   Loop — the cadence is named, not remembered). Fleet stays dark at run end regardless.
5. **Exemption shape / A/B bound:** program-wide X1/X2 apply (per-store exemptions are
   inventory entries with `reason` + `owner`; Layer A migrations bounded at 2 failed A/Bs
   with incumbent-stands + gap item as the named terminal state).

## Rollout

0. Extract the shared pattern module + pinned test; migrate/ratchet the three existing
   scrub copies onto it. Ship `scrubForStore` (metadata variant).
1. Chokepoint inventory + inventory lint + `durableOutput` axis requirement land
   (report-only → enforcing on empty pending set).
2. Layer B scrub lands dark (`monitoring.durableOutputScrub` absent ⇒ dark), soaks in
   dryRun on the dev agent; would-redact telemetry (kind/store/offset only) reviewed per
   Frontloaded Decision #4's criterion; per-pattern-kind FP rates reported, not just
   aggregate (the JWT-shaped pattern is the known FP suspect on dotted identifiers).
3. Layer A clause migrations ride the A/B protocol (digest writer already shipped —
   migrate it to the shared builder as a no-regression A/B).
4. Registry text + fleet posture ship last, operator-gated, citing the live inventory +
   scrub + soak telemetry.

## Open questions

*(none — all resolved into Frontloaded Decisions above)*
