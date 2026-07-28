# Convergence Report — Parallel-Hand PR Lease

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in every round (rounds 1–4), verdicts SERIOUS ISSUES → MINOR → MINOR → MINOR (decreasing, tracking convergence). gemini-cli/2.5-pro was available but DEGRADED (timeout) on its round-1 attempt; per the aggregate rule a single successful external family (codex, every round) satisfies the cross-model pass, so the spec-level flag is the clean `codex-cli:gpt-5.5`. The gemini timeout is recorded honestly (it was attempted, not skipped).

## ELI10 Overview

The agent can run several of its own sessions at once. On 2026-06-15 two of them tried to fix the same pull request simultaneously, each force-pushing over the other and restarting CI every time — a PR that should have merged in minutes took ~2 hours. This spec gives each branch a "lease": before a session pushes, a check confirms no other live session of the agent already owns that branch; if one does, the second session stands down instead of pushing a competing commit. The lease times out and auto-heals if the holder dies, so it can never lock a branch forever, and every uncertain case fails open (allows the push) so a broken guard never blocks real work. It coordinates only the agent's own cooperating sessions — never another person or agent — and ships dark + dry-run-first.

## Original vs Converged

The original draft had three load-bearing flaws that review caught and the rewrite fixed:

1. **Enforcement was in the wrong place — twice.** The first draft enforced in `safe-merge.mjs` (which only arms auto-merge, never pushes commits). Round 1 moved it to `SafeGitExecutor`. Round 2 caught that this was *still* wrong: `SafeGitExecutor` is instar's internal TypeScript git wrapper, but the actual thrash was Claude Code sessions running `git push` from their **Bash tool**, which never enters TypeScript. A gate there would test green and protect nothing. The converged design enforces at a **PreToolUse Bash hook** — where the agent's pushes actually happen, and where the session's topic is available (needed to recognize "is this my own lease?").

2. **Ownership keyed on the wrong identity.** The draft keyed the lease on the session ID. But the agent respawns sessions constantly (compaction, crashes, refresh), each keeping the same topic but getting a new session ID — so a restarted session would mistake its own lease for a stranger's and freeze itself forever. The converged design keys ownership on the **topic** (stable across respawns); session ID is used only to check liveness.

3. **It could wedge a branch.** The draft's "fail-closed on uncertainty" plus a single TTL could leave every hand yielding forever if the liveness probe itself failed, and could be wedged by a corrupt file or a crashing hook. The converged design fails OPEN on every uncertainty (corrupt state, hook crash, resolver hang, unknown liveness), discriminates the 90-minute ceiling by liveness (dead holder → auto-clear; live holder → escalate to operator, don't seize), and makes the hook's own crash exit-0/allow.

The review also tightened: branch-key derivation now delegates to git's own ref resolution (local fast path, remote dry-run only when ambiguous, timeout-bounded) instead of reimplementing push semantics; the cross-machine residual risk is stated honestly (machine-local v1, `holderMachineId` load-bearing only for the never-falsely-dead rule); the worktree-collision half of the incident is explicitly a non-goal; full migration parity (hook install + settings registration + CLAUDE.md + config default + backup-exclusion) is specified; and the hard-refuse is framed as a deliberate, blast-radius-limited exception to Signal-vs-Authority, not a claim that it satisfies the principle.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex(SERIOUS) | 3 blockers + ~13 material | Full rewrite: SafeGitExecutor enforcement, topic-id identity, atomic-CAS takeover, fail-open-wedge fixes, one-lock model, holderMachineId, all 6 open questions frontloaded, alternatives section |
| 2 | security+adversarial (caught the B1-REGRESSION blocker), scalability+integration (sound), decision+lessons (sound), codex(MINOR) | 1 blocker + several material | Re-target enforcement to PreToolUse Bash hook; branch-key canonicalization; cross-machine max-hold precedence; CAS forced release; anti-regression lint |
| 3 | security+adversarial, decision+lessons+integration, codex(MINOR) | 0 blockers, ~6 mechanical | Chokepoint-honesty scoping; hook own-crash fail-open; git-native key derivation; liveness-discriminated ceiling; dryRun marker; migrateSettings + denylist + latency specifics |
| 4 | security+adversarial (1 LOW), decision+lessons ("converged"), codex(MINOR — wording) | 0 material | Folded: dry-run timeout/fail-open; local-first key resolution; latency-claim split; P2-exception framing |

## Full Findings Catalog

All findings and their resolutions are recorded in the per-round consolidated notes:
- `docs/specs/reports/parallel-hand-pr-lease-round1-findings.md` (B1–B4 blockers, M1–M13, codex#1–7)
- `docs/specs/reports/parallel-hand-pr-lease-round2-findings.md` (B1-REGRESSION + M-A/B/C/D + codex#1–5)
- `docs/specs/reports/parallel-hand-pr-lease-round3-findings.md` (chokepoint honesty, own-crash, git-native derivation, liveness ceiling, dryRun isolation + codex#1–4)
- Round 4: dry-run hang→timeout/fail-open (LOW, folded); codex latency-claim split, local-first resolution, P2-exception framing (folded).

## Standards-Conformance Gate
Ran round 1 with 0 at-risk flags. (Re-runnable per round; advisory/signal-only.)

## Convergence verdict

Converged at iteration 4. Round 4 produced zero material findings (decision+lessons: "converged — no net-new material findings"; security+adversarial: one LOW, folded; codex: minor wording, folded). `## Open questions` contains only the none-marker — no live user-decision parked. The spec is ready for user review and approval. The /instar-dev BUILD is the next phase (it is NOT part of this convergence).
