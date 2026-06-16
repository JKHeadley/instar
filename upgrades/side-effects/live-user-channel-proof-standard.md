# Side-Effects Review — Live-User-Channel Proof standard + multi-machine transfer fix

**Spec:** docs/specs/live-user-channel-proof-standard.md (CONVERGED iter 6, cross-model external review, self-approved under standing autonomous pre-approval — Justin topic 13481). **Tracking:** CMT-1568. **Parent principle:** Structure beats Willpower / Observation Needs Structure.
**Ships DARK + dev-gated:** `monitoring.liveTestGate` (mode dry-run) and `multiMachine.durableOwnership` — both OMIT `enabled` so `resolveDevAgentGate` flips them live-on-dev / dark-on-fleet. Single-machine installs are a strict no-op for the transfer fix.
**Files:** src/core/LocalSessionOwnershipStore.ts (new), src/core/OwnershipApplier.ts (new), src/core/LiveTestArtifactStore.ts (new), src/core/LiveTestGate.ts (new), src/core/LiveTestHarness.ts (new), src/core/devGatedFeatures.ts, src/commands/server.ts, src/server/AgentServer.ts, src/server/routes.ts, src/scaffold/templates.ts, src/core/PostUpdateMigrator.ts, docs/STANDARDS-REGISTRY.md, docs/specs/live-user-channel-proof-standard.md (+ .eli16.md + report), tests/unit/* + tests/integration/* (8 new test files, 49 tests).

## What changed

1. **LocalSessionOwnershipStore.ts (new):** a DURABLE per-session ownership substrate implementing the existing store-agnostic `SessionOwnershipStore` interface (read + casWrite). Per-session JSON files, atomic tmp+rename, in-memory hot-path cache, fast-forward CAS. Replaces the in-memory-only store (the transfer bug's root) behind the dev-gate.
2. **OwnershipApplier.ts (new):** off-hot-path tick that materializes durable LOCAL ownership from the REPLICATED coherence-journal placement entries (read via `CoherenceJournalReader.query({kind:'topic-placement'})`), so the machine a topic moved TO resolves the right owner. Fast-forward CAS only (a stale replicated entry can never clobber a fresher local decision).
3. **server.ts:** behind `resolveDevAgentGate(multiMachine.durableOwnership.enabled)`, swaps `InMemorySessionOwnershipStore` → `LocalSessionOwnershipStore` and ticks the `OwnershipApplier` (interval + boot). Off → today's exact behavior.
4. **routes.ts (`POST /pool/transfer`):** adds an honest `seatMoved` field computed from the real post-transfer owner (+ `seatMoveReason` when false). `ok:true` now means "request processed", `seatMoved` means "the conversation actually runs on the target". Closes the 2026-06-15 `ok:true`-but-never-moved lie.
5. **LiveTestArtifactStore.ts (new):** the §4.4 signed, hash-chained artifact contract. Canonical serialization → sha256 → Ed25519 signature; per-machine ledger segments (`state/live-test-ledger.<machineId>.jsonl`, union-on-read — no cross-machine concurrent append). The gate re-reads + recomputes the hash, so a hand-edited "I tested it" record fails (the anti-hallucination core). Threat model: drift-correction, NOT an adversarial-runner security boundary (git-commit anchor is the backstop).
6. **LiveTestGate.ts (new):** the §4 completion-gate brain. allow/veto/nudge over surfaces (§4.5) + risk categories (§4.6) + BLOCKED taxonomy + the seatMoved poison rule. Signal-vs-Authority: the keyword classifier holds NO standalone blocking authority — a HARD veto requires a DECLARED `userFacing:true` + no verified artifact; an undeclared-but-classified goal gets a soft return-to-work NUDGE.
7. **server.ts + AgentServer.ts + routes.ts (gate wiring):** server.ts constructs the gate dev-gated (mode dry-run default), signing+verifying with the machine-identity keypair (`idMgr.loadSigningKey()` + derived public key). Threaded through `AgentServer` options → `RouteContext`. `POST /autonomous/evaluate-completion` post-checks a `met:true` verdict: veto-mode overrides `met:true`→`met:false`; dry-run/warn surface the would-block but honor the verdict; a gate error falls through (completion judge stays primary authority).
8. **LiveTestHarness.ts (new):** the §5 user-role scenario runner over an injected `ChannelDriver` (send/awaitReply/isDemoChannel). §5.3 structural guard refuses volatile/permission scenarios on a non-demo channel BEFORE any send. Deterministic verdicts off captured protocol evidence (reply text + responder machine id). §5.5 timeout=FAIL after bounded retries. (Real Telegram/Slack/dashboard drivers + the live proof are the tracked follow-on phase.)
9. **devGatedFeatures.ts:** two new entries — `liveTestGate` (monitoring.liveTestGate.enabled) and `durableOwnership` (multiMachine.durableOwnership.enabled), each with a non-destructive justification.
10. **STANDARDS-REGISTRY.md + templates.ts + PostUpdateMigrator.ts:** the "Live-User-Channel Proof Before Done" standard article + the CLAUDE.md awareness section (generateClaudeMd + content-sniffed migrateClaudeMd), registered in the feature-delivery-completeness parity gate (legacyMigratorSections).

## Blast radius

- **Config-gated, not wiring-gated.** With both flags dark (fleet default), every seam is a strict no-op: server.ts keeps `InMemorySessionOwnershipStore` + never constructs the applier; the gate is never constructed (`ctx.liveTestGate` null) so `/autonomous/evaluate-completion` returns the raw verdict exactly as today. On a dev agent the durable store + applier go live (no destructive write — atomic per-session JSON, reversible to InMemory) and the gate runs in dry-run (computes + logs, never overrides).
- **The gate cannot cause a false "done."** It only ever turns a `met:true` into `met:false` (keep working — the safe direction) and only in `mode:veto`; it can NEVER turn `met:false` into `met:true`. A gate error falls through to the original verdict.
- **The transfer fix changes cross-machine routing authority but only on dev.** The applier adopts only strictly-newer placements (epoch fast-forward), so it can't strand a topic ownerless or create a second owner (crash-safety proven by the integration test). Single-machine = no peer placements = no-op.
- **No new HTTP route.** The gate post-checks an EXISTING route; the transfer fix adds a field to an EXISTING route. No new MeshRpc verb, no broadcast.

## Risk + mitigation

- **Risk:** the durable store / applier mis-routes on a dev agent. **Mitigation:** dev-gated + 18 tests (durable persistence, restart-survival, fast-forward CAS, crash-safety single-owner convergence, no-split-brain). Reversible by flipping the flag (the journal remains the source of truth).
- **Risk:** the gate wrongly vetoes a legitimate completion. **Mitigation:** dry-run default (never overrides); HARD veto only on the objective `userFacing:true` + no-artifact; a gate error falls through; 11 gate-logic tests + 6 route wiring-integrity tests cover both sides of every boundary.
- **Risk:** an agent hand-writes an artifact to buy the exit. **Mitigation:** the artifact is canonical-hashed + Ed25519-signed + re-verified from disk at gate time; a hand-edit fails the hash check (proven). Honest threat model: drift-correction, not adversarial-runner.
- **Risk:** a gate/store error fails the completion route or server boot. **Mitigation:** every new path is try/catch-guarded toward the safe direction (no veto / today's verdict / InMemory store); server boot never fails on a gate-wiring error.

## Migration parity

- New dev-gated flags OMIT `enabled` in config (resolveDevAgentGate handles them) — no `migrateConfig` change needed; registered in `DEV_GATED_FEATURES` (the wiring test guards them).
- The "Live-User-Channel Proof Before Done" CLAUDE.md section ships in `generateClaudeMd` (new agents) + an idempotent content-sniffed `migrateClaudeMd` patcher (existing agents), and is tracked in `feature-delivery-completeness` `legacyMigratorSections`.
- The STANDARDS-REGISTRY.md article ships with the package (auto-distributed to existing agents).

## Dark-gate line-map

- UNCHANGED. No new inline `enabled: false` line was added to `ConfigDefaults.ts` — both new flags rely on OMISSION (the dev-gate convention), so no `enabled:` line shifted. Verified: `node scripts/lint-dev-agent-dark-gate.js` → clean.

## Rollback

- Revert the branch, OR leave the flags dark (fleet default = no behavior change). The durable-ownership flag is reversible to `InMemorySessionOwnershipStore` with no data loss (the coherence journal remains authoritative). The gate flag dark = the completion route returns the raw verdict as today.

## Evidence

- 49 new tests across 8 files (unit + integration), all green. Full unit suite green (the one transient passes in isolation — a flaky port race, not a regression). tsc clean; the full pre-commit lint suite (14 lints) clean; dark-gate lint, dev-gate wiring test, no-silent-fallbacks ratchet, feature-delivery-completeness all green.
- Spec converged through 6 rounds (6 internal reviewers + cross-model GPT + Gemini external); convergence report at docs/specs/reports/live-user-channel-proof-standard-convergence.md.
- **NOT yet done by its own standard:** the live Laptop↔Mini proof (the real-channel drivers + the deploy) is the tracked next phase; this PR ships the structural foundation DARK, with the flag flip gated on that live proof.

<!-- decision-audit trace anchor: CMT-1568 -->
