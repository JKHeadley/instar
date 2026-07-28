# Side-Effects Review — Ownership-Gated Spawn, Duplicate Reconciliation & Judgment-Within-Floors (Increment 1)

**Version / slug:** `ownership-gated-spawn-increment-1`
**Date:** `2026-07-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (required — session lifecycle + gates)`

## Summary of the change

Increment 1 of `docs/specs/ownership-gated-spawn-and-judgment-within-floors.md` (converged round 5, operator-approved 2026-07-10, all three §7 standards ratified). Adds the binding-verdict seam `src/core/SpawnAdmission.ts` (+ `resolveOwnershipSafe`) consulted at all five conversation-bound session-creating callsites (Telegram cold-spawn / two respawns, Slack inbound / recovery spawn in `src/commands/server.ts`); the owner-dark ladder rung-3 deterministic notice floor (`src/core/OwnerDarkLadder.ts`); the duplicate-session reconciler (`src/monitoring/DuplicateSessionReconciler.ts`) on a 60s lease-holder tick; the judgment-provenance log (`src/core/JudgmentProvenanceLog.ts`, machine-local `state/judgment-provenance/`); the net-new `NEVER_SERVED_PREFIXES` HTTP deny in `src/server/fileRoutes.ts`; three status/read routes (`GET /pool/duplicate-reconciler`, `GET /pool/ownership-view`, `GET /judgment-provenance`); four dev-gated flags (`ownershipGatedSpawn`, `duplicateReconciler`, `judgmentArbiters`, `commitmentCustodyTransfer`) registered in `DEV_GATED_FEATURES` + the three pool-behavior flags in `COHERENCE_CRITICAL_FLAGS`; the three ratified standards appended to `docs/STANDARDS-REGISTRY.md`; the §3.6 process hooks (spec-converge decision-point question + tag-writer structural refusal, side-effects template §4b question, `FailureRecord.judgmentCandidate` + analyzer cluster); three `PostUpdateMigrator` migrations (two skill-file patches + the gitignore patch); gitignore/backup exclusions for the provenance dir; agent-awareness template section; Capacity Safety registry entries; full three-tier tests incl. the burst-invariant E2E. **Everything ships dev-gated + dryRun (observe-only): no runtime behavior changes anywhere until deliberate flag flips that themselves require the durable substrate.**

## Decision-point inventory

- `SpawnAdmission.admit()` (`src/core/SpawnAdmission.ts`) — **add** — may this machine create a session for this conversation (5-row deterministic admission table; enforce refusals gated on durable custody).
- `OwnerDarkLadder.handleOwnerDark()` (`src/core/OwnerDarkLadder.ts`) — **add** — notify-or-stay-silent for a dark-owner conversation (deterministic guards: liveness re-check, topic-history suppression, episode dedupe, cooldown).
- `DuplicateSessionReconciler.intendedOwner()` (`src/monitoring/DuplicateSessionReconciler.ts`) — **add** — which duplicate survives (evidence ladder pin → admissible epoch → live run → ESCALATE; every ambiguity escalates, never guesses).
- `validatePath` in `src/server/fileRoutes.ts` — **modify** — adds the hardcoded never-served deny (Layers 3b + 5e).
- `write-convergence-tag.mjs` — **modify** — refuses the convergence tag when `## Decision points touched` is missing/unclassified.
- `FailureAnalyzer.analyze()` — **modify** — adds the judgment-candidate cluster (signal-only; template recommendation).
- The five spawn callsites in `src/commands/server.ts` — **modify** — consult the seam before creating a session (pass-through in dry-run).
- `_ladderDryRunConsult` in `src/commands/server.ts` — **add** — the observe-stage soak consult: on an ALLOWED spawn whose verdict is wouldBlock+other-dark, journal the ladder's would-notice in dry-run mode (never sends; bounded by the ladder's own dedupe layers). Added resolving second-pass finding 2.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

In Increment 1: **nothing** — every admission decision returns `allow: true` outside enforce mode, and enforce mode is structurally unreachable (it requires `dryRun:false` AND the durable inbound queue live on the machine — the §3.1 item-6 admission-table invariant, encoded in `effectiveMode()` and unit-tested). Residual over-block risks AT the eventual enforce flip, designed against now:
- A legitimate spawn on a machine whose ownership registry read THROWS → row (e) fails **toward the spawn** (reachability wins), bounded by the code-constant breaker. Only a breaker-OPEN enforce state (≥5 consecutive / ≥8-in-10-min registry errors) degrades to the notice floor — a sustained registry outage, not a blip.
- A single-machine install or pool-dark agent short-circuits to allow with zero writes — byte-identical dispatch (tested).
- The file-routes deny (`NEVER_SERVED_PREFIXES`) rejects exactly one prefix (`state/judgment-provenance/`), evaluated pre- and post-realpath; a normal file under `state/` (e.g. `state/swap-ledger.jsonl`) is untouched (tested for no-over-block).
- The convergence-tag refusal applies to NEW specs only (grandfathering allowlist + the `*(none)*` escape for genuinely decision-free specs); an in-flight review past round 1 can be added to `GRANDFATHERED_SLUGS` by PR.

## 2. Under-block

**What failure modes does this still miss?**

- **The fleet keeps today's behavior entirely** — dryRun everywhere means the 2026-07-10 incident CLASS still reproduces on the fleet until Increment 2 flips enforcement on the dev pool (by design: the staged rollout the operator approved; the dry-run soak is the evidence the flip requires).
- The reconciler cannot heal duplicates **wholly inside a network partition it cannot observe** (§3.2.1 partition honesty — rope-health alarms own that visibility gap).
- The seam consults at the five KNOWN conversation-bound creation callsites; a FUTURE session-creating callsite added without consulting the seam re-opens the gap — mitigated by the callsite-pin wiring test (fails if the literals move) and the Ownership-Gated Side Effects standard in the registry (review-time teeth), not by runtime interception.
- Registry-error episodes: duplicates minted during a sustained registry outage converge only after recovery (the §0 argued exemption — bounded: once per topic per episode + breaker).
- The rung-3 notice floor covers Telegram topics; a Slack conversation refused in enforce mode gets durable-queue custody where live, else a loud fail-open spawn — the Slack notice surface rides Increment 2 with the enforce flip it belongs to (the ladder records the episode journal-only for Slack today; enforce cannot engage in Increment 1 anywhere).

## 3. Level-of-abstraction fit

The seam is deliberately at the **one place sessions get created** (the callsites), not inside the router (whose verdict was already correct and already ignored — the incident's exact lesson: adding intelligence to the router changes nothing until the verdict is binding at the effect site). The reconciler converges the **record** and reuses the existing gated closeout rather than adding a new killer (no parallel reap authority). The provenance log is a new primitive because none exists (`ResponseReviewDecisionLog` caps at 200 chars by design — verified). `NEVER_SERVED_PREFIXES` lives inside `validatePath` (the chokepoint all serving routes share) rather than per-route, with explicit guards only for the two paths that bypass the validator (link route; the WS4.4 proxy is structurally view-id-scoped and cannot address file paths — its coverage is the holder-side validator).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] Yes — but the logic is a deterministic floor in the documented exemption class.

The seam holds blocking authority (in enforce mode) with deterministic logic — this is signal-vs-authority's **sanctioned exemption class** ("hard-invariant validation" + "safety guards on irreversible actions"): the one-owner-per-conversation invariant over an enumerable 5-row domain, where a false block costs a resend notice and a false pass mints a duplicate with irreversible external side effects. The spec's §0 grounds this explicitly, and the ratified **Judgment Within Floors** standard sharpens it: the ENUMERABLE rows stay deterministic; the two genuinely fuzzy points (owner-dark timing J1, messy-evidence survivor J2) are declared judgment candidates whose arbiters arrive shadow-first in Increment 3 — until then their deterministic defaults (ladder timings; escalate-to-attention) run exclusively. Every ambiguous reconciler branch ESCALATES to the operator rather than guessing. The failure-analyzer addition and the §3.6 gate questions are pure signals (template text, review prompts); the tag-writer refusal is a structural presence check whose semantic authority stays with the reviewer.

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?**

No new static heuristic at a competing-signals point. The admission table rows are enumerable invariants (classified `invariant` in the spec's `## Decision points touched`, with justification). The two competing-signals points this flow contains (J1 owner-dark timing, J2 survivor under messy evidence) are classified `judgment-candidate` with declared floors; Increment 1 ships their deterministic defaults (which are ESCALATE/fixed-ladder, not guessing heuristics — "most recent user interaction" was deliberately rejected as a rule because the wrong copy gets the last message during this bug).

## 5. Interactions

- **Shadowing:** the seam runs AFTER the router's verdict (and CONSUMES it via the TOCTOU guard — same message id — so the two cannot disagree). It does not shadow the G3 lease gate (which runs first at the cold-spawn callsite and returns before the seam on forward); both refusing is coherent (either alone suffices). The inbound-queue ordering gate and custody-ack short-circuit run before the seam unchanged.
- **Double-fire:** the reconciler defers any topic with an in-flight transfer/placement (`status transferring/placing`) and freezes during registry-error episodes — one authority in motion per topic. The rung-3 notice carries four independent dedupe layers (episode set, cooldown, pre-send liveness re-check, topic-history suppression) against split-brain double-voicing.
- **Races:** the reconciler probes fresh (5s budget) before any write; cache rows are never acted on. A CAS conflict escalates, never retries. The closeout is untouched — its own confirm-ticks/veto-breaker/guards still decide every close.
- **Feedback loops:** the reconciler's own convergence writes could re-trigger detection — bounded by 3 attempts/episode + the P19 breaker (3 episodes/24h clamps the topic, counting record FLIPS and echoed-but-unhealed episodes; transfer-traceable episodes excluded from the clamp but surfaced at volume). The Capacity Safety registry entries model both loops under sustained pressure and the convergence ratchet passes.
- **Existing tests:** the ConfigDefaults line-map golden test and the coherence-manifest membership test pass unmodified against the new entries (37 + 45 green) — no hand-update turned out to be needed (corrected per second-pass finding 11).
- **Dry-run soak consult (added post-second-pass, resolving its finding 2):** the shared `_ladderDryRunConsult` helper (src/commands/server.ts) rides all five callsites' ALLOW path: when the seam observes a would-refuse on a DARK owner, the ladder journals the would-notice in `mode: 'dry-run'` (never sends). Without it the ladder would sit dark through the whole observe stage and the enforce flip would arrive with zero ladder soak data. Volume is bounded by the ladder's own episode-dedupe/cooldown layers; the burst E2E asserts exactly ONE would-notice row per (topic, episode) under a 500-message burst.
- **Breaker-bounds asymmetry (disclosed):** the SEAM's error-arm breaker bounds are code constants (`ERROR_ARM_CONSTANTS`, §3.1 row e — spec-mandated). The RECONCILER's P19 breaker bounds (`breakerThreshold`/`breakerWindowMs`) ride `ReconcilerConfigView` from config — the spec's code-constant mandate is scoped to the seam's error arm; the reconciler's clamp stays tunable like other P19 breakers. Loosening it is a config change an operator can make; the dry-run/dev gates still bound the blast radius in Increment 1.

## 6. External surfaces

- **Other agents / install base:** all four flags ride the dev-agent gate — fleet agents get dormant code + config defaults via migration, zero behavior change. The three migrations patch agent-installed files (two skill files by full-copy-when-unmodified; gitignore by idempotent append).
- **External systems:** no new egress. The reconciler's discovery/probes/echo reads ride the EXISTING authenticated peer HTTP surfaces (`/sessions`, `/autonomous/sessions`, the new Bearer-authed `/pool/ownership-view`) at bounded cadence (60s tick, 5s per-probe budgets, per-tick caps).
- **Persistent state:** new machine-local artifacts — `state/judgment-provenance/*.jsonl` (0700/0600, gitignored via ensureGitignore + migration, backup-excluded via `NEVER_BACKUP_PATH_SEGMENTS`, 14-day retention, never HTTP-served raw) and two bounded audit logs (`logs/owner-dark-ladder.jsonl`, `logs/duplicate-reconciler.jsonl`, 5MB rotation via SafeFsExecutor). PLUS one schema change on an EXISTING durable store (per second-pass finding 9): `failure_records` gains the `judgment_candidate INTEGER NOT NULL DEFAULT 0` column via idempotent `ALTER TABLE` in the FailureLedger SCHEMA loop (duplicate-column re-runs swallowed, anything else rethrown — the TokenLedger precedent; round-trip + re-open tested in `tests/unit/FailureAnalyzer-judgment-candidate.test.ts`). Rollback note: a reverted binary leaves the extra column in place — additive, DEFAULT 0, ignored by old readers, harmless.
- **New config surface (per second-pass finding 10):** the top-level `standards.selfHealBeforeNotify.recoverableLatencyCeiling: 300` block lands in ConfigDefaults + types with NO runtime consumer in Increment 1 — deliberate per the spec's §3.8 authority clause (the key lands at the three-standards-enforcement spec's converged value; the watchers' status-route observability lines reference the SAME 300s bound as code today, and the key becomes load-bearing with the Increment-2 enforcement preconditions). An inert default: absent/present changes no Increment-1 behavior.
- **Timing/runtime conditions:** the seam adds one in-memory map lookup + (when pool active) one cached registry read per spawn decision — no synchronous durable reads on the inbound path (§3.1 item 1). The provenance writer is async-buffered.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing ACTION is added (all new routes are read-only status/observability; escalations land on the existing Attention surface with existing ack flows). "No operator-facing actions" applies.

## 6b. Operator-surface quality

No operator surface — not applicable (read-only JSON status routes; no dashboard renderer/approval/grant/revoke/secret-drop file touched).

## 7. Multi-machine posture (Cross-Machine Coherence)

Multi-machine BY SUBJECT; per-surface postures per the spec's Standard-A table:
- **SpawnAdmission verdicts:** unified (derived per-call from the replicated registry's cached view; no new durable state).
- **Ownership records the reconciler writes:** unified — the EXISTING `SessionOwnershipRegistry` CAS + journal replication; the §3.2.0 substrate gate refuses to arm on the fleet-default in-memory store (loud `substrate-not-ready`, never silent).
- **Provenance full bodies:** machine-local write, proxied-on-read (`machine-local-justification: physical-credential-locality` is NOT claimed — the correct posture per the spec is machine-local-full/HTTP-redacted: full rows carry chokepoint-redacted-but-sensitive decision context bound to the deciding machine's disk by the at-rest honesty contract; the UNIFIED read is the redacted `?scope=pool` merge).
- **Owner-dark hold state:** machine-local BY DESIGN (`machine-local-justification: physical-credential-locality` — in-flight delivery state of THIS machine's live adapter socket, per the spec's table).
- **Breaker counters:** in-module per-lease-holder state in Increment 1 (the reconciler runs ONLY on the lease holder, so the counters live where the only writer lives); the replicated-store ride + receive-side clamp land with the Increment-2 enforcement flip they protect — the clamp function (`clampBreakerRow`) ships + is unit-tested NOW.
- **User-facing notices:** one-voice-gated by the four dedupe layers incl. the topic-history suppression that covers split-brain (§3.3.3); delivered on the deterministic G1 path with the spec-declared owner-dark exception to speaker election.
- **Flag skew:** the three pool-behavior flags joined `COHERENCE_CRITICAL_FLAGS` (the machine-coherence guard alarms on a split pool); `judgmentArbiters` carries an explicit manifest exclusion with the reason (floors' static defaults make a mixed pool safe).
- No generated URLs.

## 8. Rollback cost

Pure code + config-defaults change, everything dev-gated dryRun: **revert the PR, ship as next patch.** No data migration to unwind (the provenance dir and audit logs are inert observability files; the gitignore/backup entries are safe to leave). Existing agents that took the skill-file migrations keep the new review questions (harmless prose additions; reverting them is another migration if ever needed). The three standards in the registry are operator-RATIFIED text — reverting those is an operator decision, not a rollback mechanic. No user-visible regression in any rollback window (nothing user-visible shipped ON).

---

## Conclusion

The review confirmed the Increment-1 posture is strictly observe-only with three independent belts (flag dev-gated; dryRun default; enforce structurally requires durable custody), that the seam's fail direction under registry failure is toward reachability with code-constant bounds, and that the reconciler adds no new kill authority. Two design notes surfaced and were resolved during the review: (a) the WS4.4 proxy needs no in-proxy deny because it is structurally view-id-scoped — coverage is the holder-side validator, and the wiring test pins the validator's 403; (b) breaker-counter replication is deliberately staged with the enforcement flip it protects, with the receive-clamp shipped and tested now. Clear to ship as Increment 1; the enforce flip (Increment 2) inherits its own preconditions (durable queue live, hold policy live, stale-owner-release live, two-node CI harness green) per the spec's rollout ladder.

---

## Second-pass review (required — session lifecycle + spawn/dispatch gates)

**Reviewer:** independent reviewer subagent — completed; full verdict + findings in the `## Second-pass review (independent reviewer)` section at the end of this artifact.
**Independent read of the artifact:** done — every material claim grounded against the working-tree diff; new unit/wiring/ratchet tests executed (171/171 + 45 + 37 green).

---

## Evidence pointers

- Unit: `tests/unit/SpawnAdmission.test.ts`, `tests/unit/OwnerDarkLadder.test.ts`, `tests/unit/JudgmentProvenanceLog.test.ts`, `tests/unit/BoundedJsonlAudit.test.ts`, `tests/unit/DuplicateSessionReconciler.test.ts`, `tests/unit/write-convergence-tag-decision-points.test.ts`, `tests/unit/FailureAnalyzer-judgment-candidate.test.ts`
- Wiring: `tests/unit/fileRoutes-never-served.test.ts` (403s incl. symlink evasion + edit paths), `tests/unit/spawn-admission-callsite-pins.test.ts`, `tests/unit/BackupManager-never-backup.test.ts`, `tests/unit/PostUpdateMigrator-judgment-floors.test.ts`
- Integration/E2E: `tests/integration/duplicate-reconciler-routes.test.ts`, `tests/e2e/ownership-gated-spawn-burst-invariant.test.ts` (N inbound → ZERO local sessions + ONE notice per topic-episode; observe-mode pass-through parity), `tests/e2e/ownership-gated-spawn-alive.test.ts` (Tier-3 feature-alive over the REAL AgentServer — real auth middleware 401/403, redaction-over-the-wire with a token-shaped probe, dark-posture 503s, never-served deny)
- Ratchets: `tests/unit/self-action-convergence.test.ts` (owner-dark-notice + duplicate-converge-write controllers), `tests/unit/machine-coherence-manifest.test.ts`, `tests/unit/lint-dev-agent-dark-gate.test.ts`, `scripts/lint-self-heal-fields.js` (three §3.8 blocks pass)

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (this change ADDS self-triggered controllers: the duplicate reconciler tick loop, the owner-dark notice emitter, the spawn-admission error-arm attention raiser).
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (SELF_ACTION_CONTROLLERS entries 'owner-dark-notice' + 'duplicate-converge-write'), howCaught: both controllers are driven under sustained pressure fixtures — the ladder converges to ONE notice per (topic, episode) with the episode set as the latch and owner-recovery as the only re-arm (horizon-independent: 2N ticks emit no more than N), and the reconciler converges to ≤3 attempts × 3 episodes then the P19 breaker clamps the topic to silence + ONE attention item — an unbounded repair/notice loop fails the ratchet's horizon-independence and bound assertions before it can ship.}`

---

## Second-pass review (independent reviewer)

**Reviewer:** independent subagent, 2026-07-11
**Verdict:** Concur with the review *(updated 2026-07-11 after independent re-verification — initial verdict was "Concern raised" on two items, both since resolved; original findings retained below with resolution notes)*

**Resolution re-verification (second pass, round 2):**
- **Concern 1 RESOLVED.** All three previously-missing evidence tests now exist and pass, re-run by this reviewer: `tests/unit/write-convergence-tag-decision-points.test.ts` (20 tests — `findDecisionPointGaps` parser table-/blockquote-aware, `*(none)*` escape, PLUS end-to-end refusal/stamp via `execFileSync`, PLUS a pin that `GRANDFATHERED_SLUGS` ships EMPTY), `tests/unit/FailureAnalyzer-judgment-candidate.test.ts` (7 tests — persistence round-trip incl. unfiled→undefined, idempotent ALTER re-open, cross-category cluster, diversity gate, no flag inference, idempotent upsert), and the Tier-3 alive test as `tests/e2e/ownership-gated-spawn-alive.test.ts` (real AgentServer, REAL auth middleware 401/403, redaction-over-the-wire probe, dark 503s) — the Evidence pointers now cite the real filename. 48/48 green across the resolution suites + both E2Es + callsite pins on re-run.
- **Concern 2 RESOLVED in production (the right direction).** New `_ladderDryRunConsult` helper (src/commands/server.ts:846-860): guard `!_ownerDarkLadder || !d.allow || !d.wouldBlock` + `ownership.kind === 'other-dark'` — exactly the burst harness's condition; invoked on the ALLOW path of all five callsites (once inside `admitLocalSpawn` covering the 3 Telegram sites at :2618, slack-inbound :8301, slack-recovery :10869, each additionally inside the existing try/catch). Cannot throw onto the spawn path: async fn (no synchronous throw) called `void …().catch(() => {})`, and `handleOwnerDark` mode `'dry-run'` journals only — the send branch is structurally behind `mode === 'enforce'` (OwnerDarkLadder.ts:190-196). The §2 Slack wording this reviewer flagged is now accurate (the ladder does record journal-only rows for Slack via topicId null).
- **Noted items 9/10/11 folded and verified:** the FailureLedger `ALTER TABLE judgment_candidate` disclosed under §6 with the rollback note; the consumer-less `standards.selfHealBeforeNotify.recoverableLatencyCeiling` block disclosed under §6; the §5 "updated by hand" claim corrected to "pass unmodified"; the breaker-bounds asymmetry disclosed under §5; `_ladderDryRunConsult` added to the Decision-point inventory. Also re-verified since round 1: `casConverge` still pairs `emitPlacement('reconcile')`; `DuplicateSessionReconciler.test.ts` (51 tests) green.

Original findings (round 1 — verified against the working-tree diff; note the tree was being written concurrently — `DuplicateSessionReconciler.test.ts` and the burst-invariant E2E landed DURING this review and were verified; findings 7-8 were the two concerns, now resolved as above):

1. **Enforce structurally unreachable — TRUE.** `src/core/SpawnAdmission.ts:275-279` (`effectiveMode()`): enforce requires `enabled && !dryRun && durableCustodyLive()`. ConfigDefaults ships `dryRun:true` with `enabled` omitted (dev gate); wiring reads `dryRun: ogsCfg.dryRun !== false` and `durableCustodyLive: () => !!_inboundQueue` (src/commands/server.ts). `decide()` returns `allow:true` in dry-run for every blocking row; the error arm allows unless breaker-open AND enforce. 35 unit tests pass.
2. **Five callsites wired, crash-proof — TRUE.** `admitLocalSpawn('telegram-cold-spawn'/'telegram-respawn-context-exhausted'/'telegram-respawn-dead')` each `if (!…) return;`, plus the slack-inbound and slack-recovery inline blocks — every one wrapped in try/catch that FAILS OPEN to the spawn on a seam throw. Seam-side observability deps are non-throwing (`BoundedJsonlAudit.append` swallows into its promise chain; `journalDecision`/`provenanceRow`/`raiseErrorEpisodeAttention` each try/catch). The callsite-pins test (8 tests, index-ordered) enforces the wiring; 171/171 across the five load-bearing suites I executed.
3. **NEVER_SERVED_PREFIXES — TRUE, no over-block.** Pre-realpath (Layer 3b) AND post-realpath (Layer 5e) inside `validatePath`, explicit deny on the link route (which bypasses the validator), and `isNeverEditable` consults `isNeverServed` (serve-deny ⇒ edit-deny). Exactly one prefix + exact-dir match; sibling `state/` files unaffected (14 tests pass, incl. symlink evasion).
4. **Reconciler — TRUE with one nuance.** dryRun lands no CAS (`would-converge` journal row, episode reset); every ambiguity escalates (both-live-runs, rule2/rule3 contradiction, equal-epoch tie, cas-refused, dead-target owner); `casConverge` pairs `emitPlacement(sk, r, 'reconcile', prevOwner)` and `emitPlacement` internally no-ops the journal emit unless `r.ok` ('reconcile' pre-exists in the `PlacementReason` union); substrate gate requires `durableOwnershipOn && _replicationOn` — refuses the fleet-default in-memory store. 51 unit tests pass. **Nuance:** only the per-episode 3-attempt cap (DuplicateSessionReconciler.ts:311) is a code constant; `breakerThreshold`/`breakerWindowMs`/per-tick caps are CONFIG-tunable (`SessionPoolConfig.duplicateReconciler`) — unlike the seam's `ERROR_ARM_CONSTANTS`. The artifact doesn't claim otherwise, but given the config-edit-removes-safety-bound lesson the seam's own header cites, the asymmetry is worth an explicit line (or a follow-up hardening).
5. **Provenance log — TRUE.** 0700 dir + chmod re-assert, 0600 appends, 64KB row clamp with skeleton degeneracy, retention via `SafeFsExecutor.safeUnlink`, `readRedacted` omits `contextFull` by destructuring + write-time credential scrub; `GET /judgment-provenance` serves `readRedacted` only, pool-scope peer rows clamped at 8KB each; gitignored twice (MachineIdentity `GITIGNORE_ENTRIES` + the idempotent migration) and backup-excluded via segment-matched `NEVER_BACKUP_PATH_SEGMENTS`.
6. **Signal-vs-authority / multi-machine / rollback — TRUE.** Nothing added holds blocking authority TODAY (dry-run everywhere; enforce triple-gated); the exemption-class argument matches `docs/signal-vs-authority.md:73-76`; the tag-writer refusal is a deterministic presence check with semantic authority left to the reviewer (and an EMPTY `GRANDFATHERED_SLUGS` — fine, but note it therefore applies to every spec immediately, not "NEW specs only" as §1 words it). The three pool-behavior flags are in `COHERENCE_CRITICAL_FLAGS` + the `judgmentArbiters` exclusion with reason; postures match §7. Rollback = revert-PR is real (all dark). The integration test boots a REAL AgentServer with live auth middleware and asserts 401 — the auth-bypass test lesson applied.
7. **CONCERN — evidence-pointer completeness.** *(RESOLVED — see resolution block above: all three tests now exist and pass, re-run independently.)* Three cited tests absent at review close (listed in the verdict). Consequence today: the `write-convergence-tag.mjs` decision-point gate and the `FailureAnalyzer` judgment-candidate cluster ship with no coverage, and the Testing-Integrity Tier-3 "alive" test for the reconciler routes is missing. Not a code-safety issue (everything observed is observe-only) but a false evidence claim if committed as-is.
8. **CONCERN (minor) — burst-E2E harness-parity misstatement.** *(RESOLVED — production now performs the dry-run ladder consult via `_ladderDryRunConsult` on all five callsites; guard + non-throwing contract re-verified above.)* `tests/e2e/ownership-gated-spawn-burst-invariant.test.ts:80-90` invokes `ladder.handleOwnerDark(..., mode:'dry-run')` on a dry-run would-block and comments "Observe-mode parity with production"; line 160 asserts the resulting `would-notice` row. Production `admitLocalSpawn` invoked the ladder ONLY on refusal (enforce-mode; `mode:'enforce'` hardcoded) — in production dry-run the ladder never ran and only the seam's would-block journal rows landed. Safe direction, but the asserted soak telemetry didn't exist in production; resolved by adding the dry-run ladder consult to the wiring. (Same root: artifact §2's "the ladder records the episode journal-only for Slack today" was an overstatement at round 1; it is accurate now.)
9. **Missed side effect (noted, not blocking): FailureLedger SQLite schema migration.** `ALTER TABLE failure_records ADD COLUMN judgment_candidate INTEGER NOT NULL DEFAULT 0` with a duplicate-column swallow in the constructor exec loop — a persistent-state change §6 ("new machine-local artifacts only") doesn't list, and §8's "no data migration to unwind" glosses. Additive, DEFAULT-0, idempotent, revert-safe — but it belongs in the inventory.
10. **Missed side effect (noted, not blocking): inert config surface.** `standards.selfHealBeforeNotify.recoverableLatencyCeiling: 300` landed in ConfigDefaults + types with NO code consumer anywhere in src/ (only the spec-converge SKILL prose references the key). Deliberate per the §3.8 authority clause, but the artifact doesn't mention the new top-level `standards` config block.
11. **Imprecision (immaterial): §5 claims the ConfigDefaults line-map golden test and the coherence-manifest membership test "were updated by hand" — neither file is in the diff; both pass as-is (37 + 21 tests green), so no action needed, but the claim is inaccurate as written.

---

## Post-push CI-green addendum (2026-07-11)

The first CI round surfaced seven failing files, all interaction fallout of this change — none behavioral. Fixed in the follow-up batch shipping with this addendum: (a) the no-silent-fallbacks ratchet flagged the 13 new catch blocks — each now carries an in-block `@silent-fallback-ok` declaring its LOUD path (journal row / escalation / deferral / status counter); none were silent swallows, all lacked the declaration; (b) three tag-writer test fixtures gained the now-required `## Decision points touched — *(none)*` section (the new gate applies to every stamped spec, fixtures included); (c) two source-scan wiring tests' anchors/windows updated for the seam's insertions (respawnSessionFresh window 7000→9000; the dispatch's multi-line signature + verdict arg); (d) `Duplicate-Session Prevention` tracked in the CLAUDE.md-parity guard's shared-function list. No runtime behavior change in the batch.

## Two-node-harness finding addendum (2026-07-11, pre-merge)

Building the Increment-2 entry-gate harness (real FSM, real HTTP, un-stubbed replication) surfaced a core-correctness gap the mocked unit tier could not see: in the 2026-07-10 incident's OWN shape — a bootleg spawn that duplicated the SESSION without ever touching the ownership RECORD — the reconciler's convergence CAS (`claim` on an active, already-correct, self-owned record) is refused by the ownership FSM by design (`claim-out-of-sequence`; the FSM comment even says a self-claim "masks a reconciler bug"), so the reconciler ESCALATED to the operator instead of self-healing. Fix (in `reconcileOne`, before the CAS): when the admissible SELF view already names the intended owner, skip the write entirely (no epoch burn, honoring the FSM's own principle), journal `record-already-converged`, and open the peer-echo window — the missing piece in this shape is peer replication/materialization, and the echo-confirmed path arms the existing closeout exactly as before. Both directions unit-tested (skip fires only on an admissible self view naming the verdict owner; a differing or inadmissible view still runs the CAS). No new side-effect surface: the change strictly REMOVES a write in a case where the write was always refused.
