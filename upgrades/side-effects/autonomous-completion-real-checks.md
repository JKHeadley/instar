# Side-Effects Review — Autonomous completion: real-checks verification

**Version / slug:** `autonomous-completion-real-checks`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `echo (Phase 5 — REQUIRED: touches the autonomous Stop-hook continue/stop authority + a new gate)`

## Summary of the change

Autonomous jobs gain an OPT-IN `verification_command` (+ optional `verification_cwd`; setup also records `work_dir`). When the transcript-judge (`CompletionEvaluator`, via `POST /autonomous/evaluate-completion`) returns `met:true`, the autonomous Stop hook (`autonomous-stop-hook.sh`) now RUNS the declared command and only allows the session to exit if the command ALSO passes (exit 0). Any failure mode — non-zero, timeout, missing-timeout-binary, refused-destructive, or breaker-open — routes to KEEP WORKING (the safe direction), surfacing the command's sanitized output as next-turn guidance. The judge stays transcript-only and unchanged; the real check is a second, independent, deterministic gate layered on the (rare) met path. Files: `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` (the gate `realcheck_gate`, `run_verification`, P19 breaker helpers, audit, config-read), `.claude/skills/autonomous/scripts/setup-autonomous.sh` (new flags + state fields), `src/config/ConfigDefaults.ts` (the `realCheck` config block nested in `completionDiscipline`), `src/core/PostUpdateMigrator.ts` (3 marker bumps to `REALCHECK_VERIFY` + a `migrateClaudeMd` appended subsection), `src/scaffold/templates.ts` (`generateClaudeMd`), `.claude/skills/autonomous/SKILL.md` (Write-template docs), + unit/integration/e2e tests. Spec: `docs/specs/autonomous-completion-real-checks.md` (converged, approved).

## Decision-point inventory

- `autonomous Stop-hook EXIT decision (met path)` — **modify** — a met:true verdict no longer auto-exits; it now ALSO requires the declared `verification_command` to pass (exit 0). The modification is purely additive in the SAFE direction: it can only WITHHOLD an exit, never CAUSE one.
- `realcheck_gate` — **add** — the new gate function; returns 0 (allow exit) ONLY on disabled / no-command / breaker-closed-PASS; returns 1 (keep working) on every failure mode.
- `realcheck breaker (CD_BACKOFF_STATE)` — **add** — a P19 backoff+breaker+cap sibling counter that short-circuits a stuck/flaky command (no judge re-fire, no command run) and raises ONE Attention item.
- `destructive-pattern pre-block` — **add** — a coarse literal-shape guard refusing high-signal destructive commands before execution (→ keep working).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The gate blocks the autonomous EXIT, not a user message. Its only "over-block" is keeping the agent working when the goal is actually done — which happens only if a declared `verification_command` falsely FAILS (a flaky check, a wrong CWD, a stale-artifact premise). Concrete: a job declares `verification_command: "npm test"` but the build lives in a worktree the job forgot to point at via `verification_cwd` → `npm test` from `work_dir` fails → the agent keeps working past a genuine completion. Mitigations: (a) the failure output is fed back as next-turn guidance framed as "the check may be wrong/mis-scoped — say so" (P13 / A-Wall-Is-a-Hypothesis), so the agent can correct the premise rather than grind; (b) the P19 breaker stops a persistently-failing check from spinning to duration and raises an Attention item so the operator sees the bad command; (c) the duration limit is the hard backstop; (d) the whole feature is a NO-OP unless a job declares the command, and is opt-in per job. Critically, over-block here is bounded + surfaced + recoverable — it can never cause the dangerous direction (a premature exit).

---

## 2. Under-block

**What failure modes does this still miss?**

A `verification_command` the agent constructs to falsely PASS: `verification_command: "true"`, `"npm test || true"`, a `test -f <stale-flag>` the agent `touch`ed earlier, or a PATH-shadowed `npm`. These are honestly named residuals (spec §6.2): the feature strengthens against HONEST failure (misread output, stale tree, premature "done"), not against an adversarial agent — which already holds far larger powers (edit source, push). The floor never drops below today (the independent judge still had to say met). The defeat is made DETECTABLE post-hoc via the audit row (`logs/autonomous-realcheck.jsonl` records the command + cwd + exit), not prevented. The conversational/transcript path is unchanged — this only adds a gate on the autonomous met path.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The real check is a deterministic STRUCTURAL VALIDATOR (an exit-code — `signal-vs-authority.md`'s allowed detector class), layered as a corroborator on top of the existing full-context LLM judge (`CompletionEvaluator`) which remains the primary JUDGMENT authority on the met verdict. The check runs in the Stop hook (the correct layer — it owns the continue/stop decision), reuses the existing `CD_BACKOFF_STATE` breaker machinery, the `hb_sanitize`/`hb_leak_hit` output discipline, and the `cd_raise_attention_item` notification primitive rather than re-implementing them. It does NOT add a parallel gate or a new authority — it feeds the existing continue/stop decision.

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?**

Compliant. Per `docs/signal-vs-authority.md`: an exit-code is a structural validator (the doc's explicitly-allowed detector class — "this type-checks, this length is bounded"), not a meaning-judgment. The LLM judge remains the sole *judgment* authority that must independently say met; the real check's only autonomous authority is in the SAFE (keep-working) direction — a brittle check that errs toward "keep working" (bounded by duration) is NOT the dangerous "brittle authority that blocks a legitimate action" the principle forbids. It is a corroborator that RAISES the bar for stopping, never one that forces a premature stop. Every error/ambiguity/timeout path resolves to keep-working.

---

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

- **CD_BLOCK_TERMINAL / contradictory hard-blocker:** the gate sits INSIDE the existing `if [[ "$EVAL_MET" == "true" ]]` block, AFTER the `CD_BLOCK_TERMINAL` guard + the P13 check — so a turn emitting BOTH a `<hard-blocker>` and a met-condition short-circuits before the gate (tested). The gate never runs on a hard-blocker/P13-blocked turn.
- **Native /goal mode:** the `goal_mode:native` branch returns far earlier (line ~452) — the gate is unreachable there; native runs are unaffected.
- **P19 breaker vs judge breaker:** a SIBLING counter in the same `CD_BACKOFF_STATE` sidecar (atomic `.tmp.$$`+mv writes, fails CLOSED=keep-verifying on a corrupt sidecar) — does not collide with the judge breaker.
- **Idle-backoff:** a met→fail iteration is by definition not a rapid-idle one, so the backoff self-clamp is unaffected; the verification timeout (≤120s) + judge curl (≤35s) stay far under the ~10000s registered Stop-hook timeout (no host-kill / fail-open-strand risk).
- **Adjacent (out of scope, captured separately):** the feature's integration test surfaced a PRE-EXISTING latent bug in `setup-autonomous.sh`'s multi-session start-gate — when run with `--report-topic`, no server reachable, AND `.instar/autonomous/` empty, the local-count fallback `ls …/*.local.md | grep -c…` exits non-zero on an empty glob and trips `set -euo pipefail`, aborting before the state write. NOT part of this feature; not fixed here (no-batching rule); recorded for a separate follow-up fix (`grep -c … || true`).

---

## 6. External surfaces

**Does it change anything visible to other agents, users, other systems?**

- A new audit file `logs/autonomous-realcheck.jsonl` (read-only, size-rotated). No new API route.
- One new Attention item source (`autonomous-realcheck-stuck`) when the breaker trips — deduped per run (Bounded-Notification-Surface compliant).
- Next-turn guidance gains the real-check output, sanitized (control-strip → UTF-8 scrub → leak-scrub incl. the agent's own authToken + `Bearer` → clamp) and explicitly DATA-labeled so an echoed "all tests pass" cannot launder into a later judge verdict.
- Runtime dependency: it RUNS a command unattended in the Stop hook — bounded by a portable timeout ladder (`timeout`/`gtimeout` with `-k`, else a perl `setpgrp` group-kill, else unavailable→keep-working), scrubbed env (fixed PATH, no authToken, no `npm_config_*`/`NODE_OPTIONS`), and a destructive-pattern pre-block. Timing depends on the declared command, bounded by `realCheckTimeoutMs` (default 120s) and only on the rare met path.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Cheap and instant. `autonomousSessions.completionDiscipline.realCheck.enabled: false` in `.instar/config.json` is read at the hook chokepoint each fire (no restart) and reverts to transcript-only behavior. A job simply omitting `verification_command` is already unaffected (byte-identical to today — tested). No data migration, no state repair. The migrator marker bump (`REALCHECK_VERIFY`) is idempotent; a customized hook is left untouched. Worst case (the gate misbehaves for a job that opted in) is bounded by the duration limit and surfaced via the audit + Attention item.

---

## Second-pass review (Phase 5)

**Reviewer: echo (independent pass) — Concur with the review.**

Independently traced every path through `realcheck_gate` (hook ~1095-1121) and `run_verification` (~929-1064): the cardinal invariant holds — `realcheck_gate` returns 0 (allow exit) ONLY on `RC_ENABLED != 1`, empty `VERIFICATION_COMMAND`, or `RC_OUTCOME == "pass"`; every other outcome (fail, 124 timeout, 127 unavailable, 126 refused-destructive, breaker-open, corrupt sidecar) returns 1 (keep working). All three completion-met `exit 0` sites are strictly inside `if realcheck_gate; then`; the non-completion exits (hard-blocker, emergency-stop, corrupt-state fail-safe) are correctly NOT wrapped. Breaker fail-direction verified empirically (corrupt `CD_BACKOFF_STATE` → fails=0 < threshold → echo 0 → CLOSED → check still runs — fail-CLOSED/safe). Perl timeout wrapper semantics verified live (exit-1→FAIL, exit-0→PASS, sleep-3-under-1s→124 in ~1s, no orphan). Signal-vs-authority posture legitimate (structural-validator corroborator, safe-direction-only authority, LLM judge unchanged and still primary). 24 unit + 4 integration + 2 e2e green. One under-stated nuance (a condition-path fail + same-turn legacy-promise match could run the command twice in one fire) is bounded, non-harmful (same breaker, neither can cause a premature exit), and does not affect the invariant.
