# Convergence Report — Multi-Machine Session Pool

## ELI10 Overview

Today, when your agent lives on more than one computer, only **one** of them is awake doing the work and the other just naps as a backup. This spec flips that: **every machine the agent lives on is awake at once**, and each conversation you start gets handed to whichever machine is the best fit and least busy. You never have to know — or care — which machine is actually answering you. If a machine gets overloaded, needs special hardware, you ask for a specific one, or one drops offline, the agent can **move** the conversation to another machine. To you it feels exactly like a session "restarting" today — the new machine reads the chat history and the synced files and picks right back up.

To make that safe, there's still **one** machine playing "dispatcher" (we call it the **router**), and it holds a "talking stick" so only one machine ever dispatches at a time; if the stick-holder dies, the others elect a new one. And every conversation carries a little **ownership tag** that says "machine B is running this one right now," so two machines can never accidentally answer the same chat. The whole thing ships **turned off** and turns on in careful stages, each proven on real hardware before the next — and a one-machine agent behaves *exactly* like it does today.

The review's job was to stress-test that design before a single line of code gets written. It did, hard — and it found real problems, which is the point.

## Original vs Converged (what the review actually changed)

**1. The biggest fix: we almost added a database — and shouldn't have.** The "who's in charge / who owns this chat" decisions are recorded in our shared git repo. A reviewer correctly pointed out that git isn't a perfect referee when two machines can't see each other for a moment. An earlier draft "fixed" this by bolting on a real database (Postgres/SQLite). That would have **broken one of Instar's founding rules — "everything is files, no database."** The converged spec throws that out and instead states *honestly* what git actually guarantees: when machines can reach the shared repo, git itself picks exactly one winner (a second writer is simply rejected); the only shaky moment is when a machine is cut off from the repo — and that's covered by an existing safety rule (a cut-off machine **goes quiet on its own stopwatch** before its "lease" expires, so it can't keep acting while isolated). No database. This is the honest, Instar-consistent answer.

**2. We stopped over-promising "never double-reply."** The original said "exactly once, always." The converged version is honest: *your messages and the agent's replies* are never lost or doubled (we have machinery for that). But if the agent is in the middle of an outside action — sending an email, pushing to git — when a conversation moves, that outside action isn't magically transactional; it could run twice. The spec now says this plainly and points to the fix (those actions carry their own "don't-repeat-me" tag) rather than pretending a guarantee that doesn't exist.

**3. We stopped trusting wall-clocks.** Last week we got burned by a bug where an overloaded Mac's clock appeared to jump and the agent thought the machine had gone to sleep. The reviewers caught the new design leaning on wall-clocks for "who's in charge." The converged spec uses a **stopwatch (monotonic) timer** instead — the kind that can't be fooled by a clock jump — and **quarantines** any machine whose clock drifts too far.

**4. We turned "good intentions" into actual code.** The plan to ship in safe stages was, at first, just a promise ("we won't skip a stage"). Per Instar's #1 principle — *Structure beats Willpower* — the converged spec names a real component (`StageAdvancer`) that is the **only** thing allowed to flip a stage on, and it physically refuses unless that stage's real-hardware test was recorded green. A human can't hand-edit past it.

**5. We specified the actual plumbing.** The first draft hand-waved the core path ("the router forwards the message to the owner"). The converged spec fully specifies *how* — the exact message command, how the machine confirms it got it, what happens on a timeout, and how a re-send can't cause a double. Same for moving a conversation's "memory ledger" between machines: it's now copied with a checksum, and the receiving machine **refuses to resume from a half-copied, corrupted state** and tells you honestly instead of pretending.

**6. One real decision is parked for you (and only one).** Version 1 targets a **small pool — up to ~10 of your own machines** (which comfortably covers your laptop + mini + phone). Going to dozens of machines needs a different "sharded" design, which is **pre-built into the seams** (so it's not throwaway work) but is its own future spec. This is the single thing the review left for you to confirm — see Open Design Decision #5.

## Iteration Summary

Convergence spanned **two workflow runs** — the first was interrupted partway through by a host **reboot** (which is also what triggered the session pauses you saw). The reboot killed the run *after* the panel had identified 11 open issues but *before* the fixes were applied, so no work was lost — the second run re-seeded those 11 and carried through to a clean round.

| Round | Reviewers | Material findings | New (judge) | Spec changes |
|-------|-----------|-------------------|-------------|--------------|
| Run 1, early | security, scalability, adversarial, integration, lessons-aware, GPT-external, conformance-gate | ~28 | 28 | handoff-ordering contradiction fixed; exactly-once scoped; git-substrate flagged; router-bottleneck flagged; Structure>Willpower + P10 lessons applied |
| Run 1, final | (full panel) | ~77 | 11 | **interrupted by host reboot before synthesis** — these 11 carried to Run 2 |
| Run 2, seed | (re-applied the 11) | — | — | **git-CAS rewritten to remove the wrongly-added database**; wall-clock→monotonic; router scope ≤10 + RouterShardKey seam; exactly-once honest scoping; CAS semantics corrected; SyncManifest+SHA256; topic-metadata validation; memo staleness; NTP quarantine; StageAdvancer gate |
| Run 2, round 1 | (full panel) | 66 | 12 | core dispatch path fully specified (`deliverMessage` contract); ledger-handoff sub-protocol; `StageAdvancer` + `SessionPoolE2EResultStore` grounded as real files; `migrateSessionPoolConfig()`; `PlacementExecutor` architecturally grounded; drain-timeout cancel semantics; clock-skew state machine; ownership-CAS-at-dispatch; Playbook trigger code-enforced; batching vs per-session CAS independence; per-session nonce scoping |
| Run 2, round 2 | (full panel) | 59 | **0** | **converged** — no genuinely-new material issues; remaining reviewer findings were already-addressed (line-verified) or implementation detail |

> Note on the round-2 numbers: the panel still surfaced 59 "material" findings, but the judge (with my independent spot-check confirming) ruled **all** of them already-addressed in the current spec text or out-of-scope code-existence checks (reviewers re-read the spec fresh each round with no memory of prior rounds, so they re-raise resolved concerns). Convergence = *no genuinely-new* material issues, not *zero findings*.

## Full Findings Catalog

### Run 2 seed — the 11 issues the interrupted run never applied (all addressed)

1. **Git CAS not linearizable (critical)** → §L−1 rewritten: remote ref-update is the linearization point when reachable; partition window fenced by monotonic epoch + verify-on-read + mandatory TTL self-fence. **The wrongly-introduced `LinearizableLeaseStore`/`PostgresLeaseStore`/`LocalSqliteLeaseStore` was removed** (it violated "no database dependency"). Invariants #1/#2 restated honestly.
2. **Wall-clock lease expiry (critical)** → expiry judged on the holder's monotonic-local clock + fenced epoch; wall-clock advisory only; startup clock-error check + heartbeat divergence quarantine (cites the SleepWakeDetector CPU-starvation lesson directly).
3. **Single-router bottleneck (critical)** → v0.1 scoped to ≤10 machines / 500 msg/sec; sharded design pre-specified via day-one `RouterShardKey` indirection; surfaced as Open Design Decision #5; recorded in `deferral-approvals` frontmatter.
4. **Exactly-once overstated (critical)** → Invariant #3 restated: exactly-once for channel messages + replies only; external tool side effects best-effort-once with tool-level idempotency keys. Two separate Tier-2 tests.
5. **CAS semantics inconsistent (critical)** → exact compare condition specified (fast-forward push from expected epoch; remote ref-update decides, never machineId); "lowest-machineId" demoted to a client-side retry-ordering hint. Tier-1 concurrent-CAS test.
6. **Transfer double-emit (critical)** → mutual-exclusion-on-output referenced from Invariant #3 (source stops within `transferOutputCutoffMs`; target emits only after CAS to active(epoch+2)).
7. **Partial-sync corruption (critical)** → `SyncManifest` + SHA256 verify-before-resume; mismatch → refuse corrupted resume + escalate honestly. Tier-2 kill-mid-sync test.
8. **Topic-metadata corruption (high)** → strict schema-validate-on-read → block + escalate (`topic-metadata-invalid` + Attention item); never infer/sanitize. Tier-1 test.
9. **Placement memo staleness (high)** → recovering router discards memos older than `placementMemoStaleThresholdMs` (~30s) and verifies the target is still online before reuse. Tier-2 test.
10. **NTP drift unbounded (high)** → `maxExpectedNtpDriftMs` defined; `clockSkewToleranceMs ≥ 2×` enforced at startup; divergence>tolerance on 2 beats → quarantine. Tier-2 test.
11. **E2E gate willpower-based (high)** → named `StageAdvancer` (sole stage-config writer, `Config.ts` guard) refusing advance unless prior-stage E2E recorded green for the live commit; CI belt-and-suspenders. Tier-1 test.

### Run 2 round 1 — 12 new material issues (all addressed)

1. **Message-forward to owner unspecified (critical)** → §L4 "Message Routing to Owner": `deliverMessage(sessionKey, messageId, payload, ownershipEpoch)` signed/recipient-bound; messageId idempotency; receipt-ACK-before-offset-advance; 5s/3-retry backoff; owner-unreachable→owner-dead re-placement; in-order at-most-one-in-flight per session. Tier-2 test.
2. **Ledger not wired to transfer (critical)** → §L5 ledger-handoff flow: synchronous `flushToGit()` LedgerSnapshot (manifest-covered) → transfer MeshRpc carries `ledgerSnapshotRef` → target pulls + SHA256-verifies + confirms all entries terminal → ledger-verified ACK BEFORE claim CAS; redelivery-race closed. Tier-2 test.
3. **StageAdvancer not implemented (critical)** → grounded as `src/core/StageAdvancer.ts` with private `_writeStageConfig()` + `Config.ts` read-through guard (`stage-write-not-permitted`). Tier-1 test.
4. **StageE2EResult schema/store/writer unspecified (critical)** → grounded as `src/core/SessionPoolE2EResultStore.ts`: signed append-only (reuses AuditTrail), `recordResult()` (E2E-harness-only writer), `getLatestForStage()`/`verify()`, `GET /session-pool/e2e-results`. Tier-1 test.
5. **Config migration missing (high)** → explicit `migrateSessionPoolConfig()` in `PostUpdateMigrator.migrateConfig()`: per-field existence-checked defaults; cross-knob invariant validation raising Attention. Tier-1 test.
6. **PlacementExecutor not grounded (high)** → `src/core/PlacementExecutor.ts`; pure `decide(PlacementRequest)→PlacementDecision`; synchronous wiring before CAS; JSON policy schema-validated at startup. Tier-1 wired-not-mocked test.
7. **Drain-timeout side-effect behavior unspecified (high)** → "cancel" = partial output abandoned (not sent); tool cancellation token/process.kill best-effort; CONTINUATION discloses interruption; idempotency prevents double-retry. Tier-2 test.
8. **Clock-skew quarantine FSM not explicit (high)** → `clockSkewStatus` enum {ok, divergence-detected-once, suspect-clock-removed} + full transition table (2-in/2-out); `/pool` observable. Tier-2 test.
9. **Ownership CAS timing/failure unspecified (high)** → §L4 "Ownership CAS at Dispatch": synchronous blocking CAS before routing; on non-fast-forward, re-read and route to the winner or queue (`ownership-contention`); router-owned retry with backoff; exhaustion→Attention; message never dropped. Tier-2 failover-race test.
10. **Playbook trigger not code-enforced (high)** → seeded `multiMachine-placement-deep` with explicit trigger regex bound to the assemble-triggers injector + SelfKnowledgeTree probe + PostUpdateMigrator playbook-seed migration. Tier-1 injection test.
11. **Batching vs per-session CAS atomicity ambiguity (medium)** → clarified: each session's ref-file is its own linearization point; batch is a durable-push efficiency layer only; a contended session retries alone. Tier-2 test.
12. **NonceStore per-session isolation unspecified (medium)** → scoped per `{sessionKey, sender, ownershipEpoch}` with rationale. Tier-1 isolation test.

### Run 2 round 2 — converged

The panel raised 59 material findings; the judge (line-by-line against the current spec) found **0 genuinely new** — every critical/high finding was already integrated (recipient-bound signatures, ownership-ref authority, TTL self-fence, topic validation, router scope, clock-skew FSM, atomic sync, ledger handoff) or was an implementation detail rather than a spec ambiguity. Independent spot-check confirmed: no database references remain (only the explicit "we do NOT use a database" assertions), and the §L−1 substrate model is internally consistent.

## Convergence verdict

**Converged.** No genuinely-new material findings in the final round. The spec honors every Instar design constraint it was checked against — file-based-state (no database), Structure>Willpower (safety invariants are named code components, not prose), honest guarantee scoping (exactly-once is bounded to channel messages + replies), clocks-are-unreliable (monotonic self-expiry), and no false deferrals (the one scope decision is pre-specified, not hand-waved, and surfaced for explicit sign-off). The spec is ready for user review and approval.

The one item that needs Justin's explicit decision before build: **Open Design Decision #5** — confirm the v0.1 envelope of ≤10 same-operator machines / 500 msg/sec for a single fenced router, with multi-shard horizontal scaling as a separate future spec built on the pre-specified `RouterShardKey` seam.
