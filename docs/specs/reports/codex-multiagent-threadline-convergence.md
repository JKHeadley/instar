# Convergence Report — Codex Multi-Agent Threadline Robustness

**Spec:** docs/specs/CODEX-MULTIAGENT-THREADLINE-SPEC.md
**Date:** 2026-05-24
**Mode:** expedited (operator-elected, topic 12304) — two-reviewer pass on the
spec + the already-implemented + live-verified code, not a full multi-round
multi-model convergence. Justified because both fixes were root-caused and
empirically verified before the spec was written.

## Reviewers

- **Correctness / integration** (general-purpose): verified the diff, ran the
  unit suite (green), typechecked clean. Conclusion: both fixes correct;
  flagged a stale JSDoc `@example` and the absence of a full argv→tmux→codex
  integration test (live verification is interim coverage).
- **Adversarial / side-effects** (general-purpose): conclusion "Fix B solid;
  Fix A's blunt full-bypass-as-default is the merge blocker." Raised the
  job-sandbox regression, questioned whether a sandboxed-but-MCP path exists,
  and found the unwired second reply path (`PipeSessionSpawner`).

## Findings → resolutions

1. **Job sandbox regression (adversarial, MUST-FIX) → ADOPTED.** Global bypass
   unsandboxed scheduled jobs. Resolved: bypass scoped to reply workers via
   `codexAllowMcpTools`; jobs keep `workspace-write`.
2. **"Is there a sandboxed MCP path?" (adversarial) → VERIFIED NO.** Empirically
   tested codex 0.133: `--sandbox workspace-write` (incl. `--full-auto`) leaves
   `threadline_send` unavailable/cancelled. Full bypass is the only working
   mode. Documented as the security posture (operator sign-off obtained).
3. **Second reply path unwired (adversarial) → ADOPTED.** `PipeSessionSpawner`
   also uses `threadline_send`; now wired with `codexAllowMcpTools` + the
   per-agent override (Fix C).
4. **`-c` injection safety (adversarial) → CHECKED, low risk.** argv array (no
   shell) on the SessionManager path; JSON.stringify yields valid TOML-array
   values; PipeSessionSpawner shell-quotes each element preserving the JSON.
5. **Stale JSDoc `@example` (correctness) → FIXED.**

## Security sign-off

Codex reply workers run under full bypass (no sandboxed alternative exists).
Bounded by Threadline's trust gate (messages only from trusted agents). Operator
accepted (topic 12304, 2026-05-24). Jobs remain sandboxed.

## Outcome

Converged. Both fixes implemented to the targeted design; unit tests green;
Fix-A mechanism (bypass → `threadline_send` completes) live-verified. Full
deployed round-trip is the post-merge Tier-3 acceptance.
