# Side-Effects Review — CI housekeeping: dev-gate canonicalization + decision-audit + lint

**Change:** Three CI-correctness fixes the now-wired husky gate (npm run prepare) surfaced on the B1-B5 commits (the build worktree was created with raw `git worktree add`, so the gate hadn't run):
1. **Dev-gate canonicalization (real source fix):** route every dev-gated resolver I added through the canonical `resolveDevAgentGate(explicit, config)` instead of hand-rolling `explicit ?? !!developmentAgent` — per DEV-AGENT-DARK-GATE-ENFORCEMENT-SPEC. 6 sites: MultiMachineCoordinator (resilientRenew, churnDetector, pollFollowsLease), server.ts (skewImmuneLiveness ×2 closures), TelegramLifeline (pollFollowsLease). Behavior-identical (the helper IS `explicit ?? !!config.developmentAgent`), now standard-conformant + lint-clean.
2. **Decision-audit backfill:** honest Tier-2 records in `.instar/instar-dev-decisions.jsonl` for the B1-B5 commits (gate evidence the un-wired husky shim didn't write).
3. **Test lint-allow:** `safe-git-allow`/`safe-fs-allow` comments for pollIntent.test.ts's per-test tmpdir rmSync (the SafeFsExecutor-containment lint's documented test convention).

**Files:** `src/core/MultiMachineCoordinator.ts`, `src/commands/server.ts`, `src/lifeline/TelegramLifeline.ts`, `tests/unit/pollIntent.test.ts`, `.instar/instar-dev-decisions.jsonl`.

## Phase 1 — Principle check
The dev-gate canonicalization is behavior-preserving (identical resolution, now via the shared helper). No new decision/authority. Items 2-3 are pure process/lint.

## 1-8 (over/under-block, abstraction, signal-vs-authority, interactions, external, multi-machine, rollback)
N/A behavior change — `resolveDevAgentGate` returns exactly the prior expression, so every gate resolves identically (live-on-dev / dark-on-fleet). No external surface, no multi-machine posture change. Rollback: trivial (the helper call ≡ the inline expression). 48 unit tests pass unchanged; dev-gate-dark lint clean.

## Phase 5 — Second-pass review
Not required — a behavior-preserving canonicalization to the standard helper + audit/lint housekeeping; no new runtime behavior, decision, or authority. (The underlying B1-B5 features each had their own second-pass already.)
