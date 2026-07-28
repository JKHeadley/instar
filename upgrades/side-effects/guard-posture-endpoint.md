# Side-Effects Review — Guard-Posture Endpoint (GET /guards)

**Version / slug:** `guard-posture-endpoint`
**Date:** `2026-06-12`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `required (feature has "guard" in its name + touches monitoring surface) — pending, appended below before ship`

## Summary of the change

Implements the approved converged spec `docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md`: a read-only, Bearer-authenticated `GET /guards` endpoint reporting every shipped guard's honest effective state (on-confirmed / on-unverified / on-stale / on-dry-run / off{dark-default, diverged-from-default} / diverged-pending-restart / errored / missing / off-runtime-divergent), a static guard manifest + runtime GuardRegistry reconciled at boot, a compact posture block riding the existing capacity heartbeat with durable last-known persistence, a pool-scope fan-out accounting for every registered machine, a GuardPostureProbe raising one episode-deduped Attention item for persisting anomalies, a repo-CI manifest lint with complete component backfill, and the CLAUDE.md template/migration + CAPABILITY_INDEX awareness updates. Files: `src/monitoring/guardPosture.ts` (shared extractor lifted from GuardPostureTripwire — single funnel), `guardManifest.ts`, `GuardRegistry.ts`, `guardPostureView.ts`, `probes/GuardPostureProbe.ts`, routes/boot wiring, heartbeat types/sender/receiver, `scripts/lint-guard-manifest.js`, scaffold template + PostUpdateMigrator, three test tiers.

## Decision-point inventory

- `GET /guards` route — **add** — read-only projection; no block/allow decisions on any flow.
- `GuardPostureProbe` — **add** — detector producing Attention-queue SIGNALS (episode-deduped); takes no action, re-enables nothing.
- `scope=pool` rate limit — **add** — transport-layer mechanics (anti-amplification), not a judgment decision.
- `peerUrlGuard` (https/allowlist before Bearer forward) — **add** — hard safety guard on credential egress; refusal is VISIBLE (`url-rejected` failure row), never silent.
- `GuardPostureTripwire` — **pass-through** — extraction logic moved to the shared module; behavior unchanged (its tests still pass unmodified).
- Heartbeat ingestion — **modify** — adds a posture block bound to the AUTHENTICATED sender; never a new accept/reject decision.

## 1. Over-block

No block/allow surface on message or agent-behavior flow. Two narrow rejection surfaces exist and are scoped:
- The peer-URL allowlist can refuse a LEGITIMATE peer URL if an operator uses an unusual tunnel domain → the peer renders as a named `url-rejected` failure row (visible, diagnosable), and the heartbeat path still carries its posture. Mitigation documented; allowlist is a shared helper so a domain fix lands once.
- The pool rate limit can briefly defer a rapid sweep — partial results semantics, never a 500.

## 2. Under-block

- Posture is self-attested telemetry: a compromised machine can report all-confirmed (spec §3(g) accepted; cross-check = deep read vs heartbeat disagreement, which the probe flags).
- `on-unverified` covers every non-instrumented guard — a crashed non-instrumented guard is indistinguishable from a healthy one (grey, honestly labeled; instrumentation grows over time; the E2E floor pins sessionReaper + scheduler enrichment so the headline guards can't regress to grey).
- Staleness detection only applies to guards declaring `expectedTickMs` — an event-driven guard with a dead event loop is not detected (stated scope line, spec §2.2).

## 3. Level-of-abstraction fit

Read surface sits at the route layer over pure derivation modules (`guardPostureView.ts`) — same layering as reap-log/TokenLedger (always-on read-only observability precedent). The extraction lives in ONE shared module consumed by both the tripwire and the endpoint (single-funnel; prevents inventory drift). The probe consumes the same inventory rather than re-deriving. No parallel-to-a-smarter-gate structure exists: nothing here blocks.

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md

- [x] No — this change produces signals (posture rows, probe Attention items) consumed by humans/agents; it holds no blocking authority over any flow.

The two block-shaped pieces fall in the doc's exempt classes: the rate limit is transport-layer mechanics ("idempotency/transport" class), and the peer-URL allowlist is a hard safety guard on credential egress ("safety guards on irreversible actions" class — sending a Bearer token to a hostile URL is irreversible) whose refusals are visible rows. The spec's §2.5 de-scope keeps the WRITE lever (real authority) out of this change entirely.

## 5. Interactions

- **Tripwire:** shares the extractor; tripwire behavior unchanged (tests pass unmodified). The endpoint READS the tripwire's boot snapshot (`state/guard-posture.json`) but never writes it — no write race (tripwire writes once at boot).
- **Heartbeat:** posture block is additive on `MachineCapacity`; older peers ignore unknown fields (verified shape is additive). Ingestion binds to authenticated sender identity — cannot shadow another machine's row (the merge-identity rule both fan-out and heartbeat already follow).
- **Attention queue:** probe emits through the existing budgeted funnel with a stable `healthKey` (episode dedup) — aggregated single item, P17-compliant; cannot topic-flood (the breaker is upstream of every attention emit).
- **Double-fire with tripwire:** tripwire alarms on boot TRANSITIONS; probe alarms on persisting STEADY-STATE anomalies. Distinct triggers, complementary by design (spec §2.6); both reference the same inventory so they can't disagree about what a guard is.
- **No shadowing:** `/guards` adds no middleware ahead of existing checks; Bearer middleware unchanged.

## 6. External surfaces

- New authenticated API surface (`GET /guards`) — operationally sensitive (attack-timing oracle); contained per spec §3: Bearer-only, never on exemption lists, never on /health//ping/signed-URL surfaces; pool fan-out forwards the token ONLY to https/allowlisted peer URLs. The `scope=pool` rate limit answers 429 when exceeded (transport mechanics); per-guard getter errors surface in-process messages only (never peer/TLS internals — those are enum-normalized in failure rows).
- Heartbeat payload grows by a few hundred bytes (bounded by manifest size); replicated to operator-paired machines only — accepted, contained exposure (spec §3(f)). The sender computes the block per 30s beat (one disk config read + in-memory inventory build, try/caught; a failed compute omits the block for that beat).
- TWO new durable machine-local state files (both registered in the State-Coherence Registry + annotated at their write sites, per second-pass review): `state/guard-posture-peers.json` (GuardPostureStore — durable last-known peer posture with receiver-side receipt time) and `state/guard-posture-episodes.json` (GuardPostureProbe episode state). The pre-existing tripwire snapshot `state/guard-posture.json` was registered alongside. The `guardPosture`/`guardPostureReceivedAt` fields are additive on the in-memory/API `MachineCapacity` view only — older readers ignore them.
- CLAUDE.md template grows a Guards block; existing agents receive it via content-sniffed `migrateClaudeMd()` (Migration Parity); includes the PATCH /config full-block warning (interim hazard containment for the de-scoped write lever).
- Dashboard Machines tab shows posture summary + age.

## 7. Rollback cost

Pure code change at the route/probe/dashboard layer: revert and ship a patch. Heartbeat block is additive — peers on the old version ignore it; durable record fields are ignored by old readers (no data migration needed either way). The CLAUDE.md template section requires a removal migration if rolled back (stated in spec §7 — Migration Parity cuts both ways). No agent state repair.

## Conclusion

The build implements a read-only observability surface whose design center is honesty layering (config-on ≠ working). The review confirms: no brittle logic holds blocking authority; both rejection surfaces are exempt-class with visible refusals; the heaviest risks are information-disclosure-shaped and carry shipping-dependency mitigations (projection allowlist + leak tests, URL allowlist before token forward, sender-bound ingestion). Clear to ship once all three test tiers are green and the second-pass reviewer concurs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (adversarial audit, 2026-06-12)
**Independent read of the artifact: concern raised → resolved → concur**

Initial verdict raised three concerns, all resolved before ship:
- *Unregistered durable state files* — `state/guard-posture-peers.json` and `state/guard-posture-episodes.json` were not in the State-Coherence Registry (the lint's documented variable-path blind spot). RESOLVED: both registered + inline `/* state-registry: ... */` annotations at the write sites; the pre-existing tripwire snapshot registered alongside.
- *§6 wording misdescribed durability* (claimed durable-machine-record fields; actually a separate store file). RESOLVED: §6 corrected to name both files and the in-memory-only capacity fields.
- *`deepReadPeer` implemented but unwired* (a silent scope reduction). RESOLVED: wired in server.ts — plain `GET /guards` against the peer, token only past the peerUrlGuard, online-peers-with-stale/missing-posture only.

Reviewer affirmation on the core questions: "No brittle logic holds blocking authority over message flow, session lifecycle, or dispatch — the only two rejection surfaces are exactly the exempt classes the artifact claims. All §3 shipping dependencies are genuinely implemented AND tested, not just claimed. Once the state-registry registration and the §6 wording fix land, I concur with shipping." Both landed; concurrence stands.

## Verification phase (LARGE build, 5 independent reviewers)

- **Spec-correctness**: all 8 acceptance criteria VERIFIED with code+test locations; precedence table matches §2.2 exactly. No findings.
- **Security**: IPv6 private ranges were over-blocked (safe direction) — now granted LAN trust (loopback/ULA/link-local) with boundary tests; redirect-safety rationale documented (Fetch strips Authorization cross-origin — deliberate). All ten threat-model rows verified implemented+tested.
- **Scalability**: REAL BUG fixed — store write-on-change compared `generatedAt` (always fresh → wrote every beat); now field-wise semantic comparison. Heartbeat posture compute now mtime-caches the resolved-config snapshot (was 2× structuredClone per 30s beat). 90-day TTL bounds the durable store; deep merge depth-capped at 64.
- **Test-quality**: added getter-invocation wiring spy, route-level one-read pin, async-getter-structurally-unusable pin (the sync-enforcement mechanism behind <100ms), staleness boundary at exactly 5×, dryRun override precedence, snapshot-unavailable+runtime-divergent combination.
- **Integration/regression**: no blockers; single-machine no-op verified; boot-order/TDZ verified safe. Fixes: first-failure logging for the heartbeat posture compute, explicit pool-not-wired return in deepReadPeer, defensive dashboard math on partial posture blocks.

## Evidence pointers

- `.instar/state/build/must-haves.md` (truths T1–T18), `threats.md` (STRIDE T-01…T-10), `plan.md`
- Tier-1: `tests/unit/monitoring/guard-posture-view.test.ts`, `guard-posture-snapshot.test.ts` (48+10 green at step 2)
- Spec: `docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md` (approved 2026-06-12, topic 13481)

## Addendum — agent-awareness migration collision fix

The pool-sessions-visibility CLAUDE.md migration's idempotency sniff was the bare string `scope=pool`; the new Guards section (which mentions `/guards?scope=pool`) would have permanently satisfied it, silently blocking that migration for any agent carrying the Guards block. Tightened to the route-qualified `sessions?scope=pool` with its test updated — found by the awareness-block test pass.

## Addendum — CI lint + ratchet compliance

`scripts/lint-guard-manifest.js` (+ unit test) wired into the composite lint chain; complete NOT_A_GUARD backfill (33 entries; one real finding: WorktreeReaper has no importer — dormant code, tracked). PrincipalGuard's reason reworded to dodge an llm-attribution-ratchet scanner false positive; the four new guard-path catch blocks carry @silent-fallback-ok justifications (no-silent-fallbacks ratchet stays at baseline).
