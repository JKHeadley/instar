# Side-Effects Review — Coherence Journal P1.1 (writer core + emission wiring + registry lint)

**Version / slug:** `coherence-journal-p1-1`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required as a PR-time pass — the DESIGN went through 4-round multi-reviewer convergence (security/scalability/adversarial/integration/lessons + codex-cli:gpt-5.5 external, report at docs/specs/reports/coherence-journal-convergence.md) and this implementation tracks that converged spec section-by-section; deviations are enumerated below`

## Summary of the change

Implements P1.1 of `docs/specs/COHERENCE-JOURNAL-SPEC.md` (converged, `approved: true`, Justin 2026-06-05): `CoherenceJournal` writer class (non-blocking enqueue-assigned seq, 250ms flusher, advisory lock, typed per-kind schemas, artifactPath jail, restart-proof op-key dedupe, incarnation + crash-safe highWaterSeq, per-kind rotation incl. rotate-never-delete); emission wiring — `StateManager.saveSession` status-diff funnel (session-lifecycle), `emitPlacement` paired at all 8 ownership-CAS call sites (server.ts ownAction ×4, router place/claim, transfer-planner release, POST /pool/transfer release), reaper `reaped` emit beside the reap-log append, autonomous-run scanner (60s) + stop-funnel seam; `StateManager.guardJournalWrite` (standby-safe, prefix-allowlisted); `src/data/state-coherence-registry.json` (66 census categories) + `scripts/lint-state-registry.js` and `scripts/lint-cas-emit-placement.js`, both chained in `package.json` lint; ConfigDefaults + types (dark-ship: `enabled ?? !!developmentAgent`).

## Decision-point inventory

- `StateManager.guardJournalWrite` — ADD — permits journal-prefix writes on a read-only standby (independent of `_sessionPoolActive`); REFUSES paths escaping the canonicalized journal prefix. Spec §3.1; 7 tests.
- `lint-state-registry` / `lint-cas-emit-placement` — ADD — CI-time guardrails (build fails, never runtime).
- The journal writer itself holds NO runtime decision authority: emits are observational, never gate the observed operation (§3.9), and every emit path is wrapped so a journal failure cannot throw into or slow its caller.

## 1. Over-block

`guardJournalWrite` could over-block only by mis-canonicalizing a legitimate journal path — covered by tests (own streams, peers/, meta/lock sidecars all permitted; sibling-prefix dirs refused). The CI lints can over-block future PRs on false positives: `lint-state-registry` accepts the `/* state-registry: <category> */` inline annotation as the documented escape; `lint-cas-emit-placement` pairs per-token within ±12 lines (calibrated against all 8 real sites). No runtime over-block surface.

## 2. Under-block

The lints are guardrails, not proofs (stated in their headers + the spec): wrapper-hidden writes/CAS calls can evade the pattern sweep. The declared duty ("new store registers itself"; "every ownership mutation pairs an emit") remains the authority. Accepted per the converged spec §3.3/§3.6.

## 3. Level-of-abstraction fit

One refinement over the spec letter, at a STRONGER layer: §3.3 prescribed a `recordLifecycle(sessionId, status)` funnel that the (eleven) SessionManager status-transition sites call. Implemented instead INSIDE `StateManager.saveSession` as a status-diff (prev-on-disk vs next): every transition already passes through saveSession, so no call site exists to forget — the exact drift the spec's own convergence flagged about "naming three sites". The spec's intent (single funnel, no per-site wiring, per-transition wiring tests) is preserved and strengthened; the letter (a SessionManager method) is deviated from, recorded here.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no runtime block/allow surface (the journal is signal-only by spec §3.9; the lints act at CI, the documented place for structural guards).

## 5. Interactions

- **saveSession funnel:** adds one small read-before-write per save (non-hot path); a journal emit failure is swallowed (tested: throwing journal, saveSession still persists). No emit on metadata-only saves (status unchanged) — tested.
- **Double-fire:** scanner observed-stopped + funnel-stop emit for the same run collapse via the shared `(topic, runId, action)` op key and the shared `autonomousRunId()` formula (exported, single source). placement emit retries collapse via `(topic, epoch)`.
- **Races:** two server processes — the advisory lock makes the second writer a surfaced no-op (tested: no torn lines, no forked seq). Reaper + funnel both touching a session: 'reaped' is emitted ONLY at the reap event (funnel maps killed/completed/failed), no double-status.
- **Shadowing:** `guardJournalWrite` is additive; the existing private `guardWrite` and its `sessionScoped` semantics are untouched.
- **Feedback loops:** the journal subsystem emits nothing about itself (writer excluded; scanner reads `.local.md` files only).

## 6. External surfaces

- **Other agents/fleet:** dark-ship — `enabled ?? !!developmentAgent`; fleet agents get inert config via `migrateConfig`'s applyDefaults backfill (Migration Parity §3.8). The two lints run for every CONTRIBUTOR build (CI-time, not agent-runtime).
- **Persistent state:** new files only under `state/coherence-journal/` (registered as the registry's first entry). Stored session records unchanged.
- **Spec deviations recorded:** (1) funnel-at-saveSession (above, stronger); (2) journal SessionStatus enum gains `'failed'` — Session records carry a real terminal `failed` the spec's §3.2 enum missed; recording it as killed/completed would misstate history (additive; readers ignore unknowns); (3) TelegramAdapter's emergency-stop `stopAutonomousTopic` call site is NOT directly seamed (the adapter holds no StateManager) — covered by the scanner's observed-stopped within ≤60s per the spec's own defense-in-depth; direct seam rides P1.2 when the adapter is touched anyway <!-- tracked: multimachine-coherence-topic-placement-history-api -->; (4) Agent-Awareness CLAUDE.md template entry ships with the READ API in P1.2 per spec §3.8 (no route exists yet to document).
- **The cas-pairing lint caught a real miss during development:** the `POST /pool/transfer` release half had no emit until the lint flagged it — the structural guard demonstrably works.

## 7. Rollback cost

Code revert + patch release. Journal files left on disk are inert and plain-JSONL readable (spec §3.7 rollback semantics). Lint + registry JSON revert together (same PR, same revert). No data migration; no agent state repair.

## Conclusion

Implementation tracks the converged spec with four recorded, rationale-carrying deviations (none weakening a safety property; two strengthening). The riskiest surface — hot-path cost — is structurally bounded (memory-only emit, fault-injection tested). 56 new tests green + 357 across the affected surface; both new lints clean on the real tree; tsc clean. Clear to ship dark.

## Second-pass review (if required)

**Reviewer:** design-level convergence panel (4 rounds, 5 perspectives + external cross-model)
**Independent read of the artifact:** the convergence report stands as the design review; PR CI + operator spot-check per Tier-2 process.

## Evidence pointers

- `tests/unit/CoherenceJournal.test.ts` (33), `coherence-journal-wiring.test.ts` (9, independent oracles), `state-manager-guard-journal-write.test.ts` (7), `lint-state-registry.test.ts` (7)
- `node scripts/lint-state-registry.js` → clean (66 categories); `node scripts/lint-cas-emit-placement.js` → clean (8 sites)
- Affected surface: 29 files / 357 tests green; `tsc --noEmit` clean
