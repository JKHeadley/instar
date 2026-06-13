# Side-effects review — OrphanedWorkSentinel (silent-uncommitted-death backstop)

## 1. What changed

A new dark, dev-gated, signal-only monitoring sentinel that detects agent worktrees with uncommitted work whose owning session is dead + settled, records them durably, and raises ONE deduped agent-health attention item. Optional off-by-default non-destructive preservation patch.

- `src/monitoring/OrphanedWorkSentinel.ts` — class + pure classifier + config.
- `src/monitoring/orphanedWorkGit.ts` — git/fs-backed deps (reuses `agentWorktreeGit` helpers).
- Config type (`src/core/types.ts`), default with `enabled` OMITTED (`src/config/ConfigDefaults.ts`).
- Dev-gate registration (`src/core/devGatedFeatures.ts`).
- Server wiring (`src/commands/server.ts`), route ctx + `GET /orphaned-work` (`src/server/AgentServer.ts`, `src/server/routes.ts`).
- Route classification in `src/server/CapabilityIndex.ts` (INTERNAL — observability the agent reads).
- 3-tier tests: unit (classifier + real-git deps), integration (route), e2e (feature alive).

## 2. Blast radius

Read-only on the fleet (dark; route 503s). On a dev agent: a background timer runs one git/lsof scan per `scanIntervalMs` (default 10 min) over the agent's `.worktrees/`, records to `state/orphaned-work.jsonl`, and may raise ONE agent-health attention item per stranded worktree episode (deduped on path+content-signature; the agent-health lane routes to the calm "🩺 Agent Health" topic — never a per-item topic flood).

## 3. Destructive actions

None by default. The only mutation is the optional `preserveWork` sub-flag (off for everyone): it writes a patch FILE under the state dir from `git diff HEAD` (read-only) + the untracked file list. It never touches the worktree, its index, or any ref, and never deletes anything.

## 4. Reversibility

Fully reversible: it ships dark; disabling the dev-gate (or `enabled: false`) stops it. No data migration, no schema change. The durable jsonl + patch files are additive and bounded.

## 5. Failure modes

- `lsof`/git read failure → empty/clean signal → SKIP (never a false orphan). Recording/attention are best-effort (wrapped) and never throw the scan pass. Server wiring is wrapped in try/catch (non-fatal). Episode dedupe prevents re-alert spam; `maxFlagsPerPass` bounds blast radius.

## 6. Operator-surface quality

N/A — this change touches NO operator surface (no dashboard renderer/markup, no approval/grant/secret form). The only user-facing output is a plain-language agent-health attention item, authored in plain English ("a build died here with uncommitted changes — open the worktree to finish it, or discard"). No raw internals are surfaced to the user.

## 7. Standards

- Dev-agent dark-gate: `enabled` OMITTED + registered in `DEV_GATED_FEATURES` (lint + wiring test green).
- Migration Parity: default added to `ConfigDefaults.ts` → `applyDefaults` propagates to existing agents automatically.
- Testing Integrity: all 3 tiers + real-git wiring-integrity test.
- Capability discoverability: route prefix classified INTERNAL.
