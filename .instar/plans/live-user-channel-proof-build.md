# Build Plan — Live-User-Channel Proof + Multi-Machine Transfer Fix

Spec: `docs/specs/live-user-channel-proof-standard.md` (CONVERGED iter 6, self-approved).
Worktree: `~/.instar/agents/echo/.worktrees/gold-standard-live-testing` (branch
`echo/gold-standard-live-testing` off `JKHeadley/main` v1.3.586).
Tracking: CMT-1568. Autonomous run topic 13481.

## Build order (each its own PR through full gates)

### A. Transfer fix (Task #5) — the real bug, highest value. IN PROGRESS.
Root cause: `SessionOwnershipRegistry` uses `InMemorySessionOwnershipStore` (no
cross-machine replication). Registry is already store-agnostic (`SessionOwnershipStore`
interface read+casWrite). Fix = durable + replicated store, off hot path.

Increments:
1. **`LocalSessionOwnershipStore`** (durable per-session persistence). Mirror
   `src/core/LocalLeaseStore.ts`: file-per-session JSON, atomic tmp+rename, in-memory
   Map cache, fast-forward CAS (`candidate.ownershipEpoch > current`). + unit test.
   → survives restart. ⟵ DOING FIRST.
2. **`OwnershipApplier`** — on each machine, consume REPLICATED peer placement journal
   entries (`peers/<machineId>.topic-placement.jsonl`, already replicated by the journal
   sync) and CAS-materialize the ownership record locally, so the target machine's
   `resolveOwnership` returns owner=self after a transfer. Runs on journal-apply tick
   (OFF hot path). Fenced by leaseEpoch (stale-lease placement discarded). + unit test.
3. **Wire** at `src/commands/server.ts:14612` — swap `InMemorySessionOwnershipStore` →
   `LocalSessionOwnershipStore`; wire the `OwnershipApplier` to the journal sync;
   keep `epochFloorOf` reading freshest journaled epoch. Dev-gated/dark per convention.
4. **False-positive surfacing** (§7.4) — `/pool/transfer` returns explicit
   `seatMoved:false` (not bare `ok:true`) when ownership didn't actually move.
5. **Crash-safety** (§7.3, §9.4) integration test: crash at each step → single-owner
   convergence + contended messages queue (not double-route).
6. Layered tests (unit/integration/e2e), zero-failure suite, side-effects review,
   PR through gates.

### B. Constitution standard (Task #2) — small, operator's explicit ask.
- Add "Live-User-Channel Proof Before Done" to `docs/STANDARDS-REGISTRY.md` (Rule /
  In practice / Earned from / Traces to the goal / Applied through — text in spec §3).
- Agent awareness: `src/scaffold/templates.ts` generateClaudeMd.
- Migration: `PostUpdateMigrator.migrateClaudeMd` / `migrateAgentMdSections` +
  `migrateConfig` for new dark flags. Idempotent, content-sniffed.

### C. User-role harness (Task #4) — the big new build.
Per spec §5: scenario matrix, real-account drive (B-class) via isolated demo channels,
signed artifact + per-machine hash-chained ledger segments, flake mgmt, Tier-1 supervisor
(semantic-only), layered tests incl. "alive" e2e. Reuse `test-as-self` throwaway-home.

### D. Completion gate (Task #3) — depends on C's artifact format.
Per spec §4: deterministic pre-check, block on objective facts only (declared userFacing
+ verified signed artifact), classifier signal-only, risk-category coverage, surface-
specific proof, dark→warn→veto. Hooks `CompletionEvaluator` / `UnjustifiedStopGate`.
Config `monitoring.liveTestGate` in `DEV_GATED_FEATURES`. Layered tests both sides.

### E. Apply standard to multi-machine FIRST (Task #6) — the bar.
Run harness over the transfer through Telegram AND Slack on a throwaway topic; signed
all-PASS artifact; deploy both machines.

## Key wiring facts (from grounding)
- Swap point: `src/commands/server.ts:14605-14617`.
- `emitPlacement` wrapper: server.ts:14716-14741; CAS sites: 14748-14751.
- Reconciler emitPlacement wiring: server.ts:14683-14694.
- `SessionOwnershipStore` interface + FSM: `src/core/SessionOwnership.ts`,
  `SessionOwnershipRegistry.ts`. `CoherenceJournal.emitPlacement`: CoherenceJournal.ts:680.
- Lease fencing: `FencedLease.ts` / `LeaseCoordinator` leaseEpoch.
- Tests pattern: `tests/unit/SessionOwnership.test.ts`, `MeshRpc.test.ts`.

## Gate checklist (instar-dev) — clear BEFORE push
husky shim, decision-audit (causalAutopsy in trace JSON), docs-coverage ≥2 CLAUDE.md
mentions per new feature, no-silent-fallbacks tag on new routes, feature-delivery-
completeness, eli16 (PR body ≥200 chars under ## ELI16), dark-gate golden line-map
(recompute on ConfigDefaults edits), capability index for new routes, migration parity.
Self-approve specs (standing pre-approval). Green-PR auto-merge / native auto-merge is
the merge path (`gh pr merge --auto --squash`).
