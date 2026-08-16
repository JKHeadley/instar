# Side-Effects Review — Activity-Aware SessionManager Timeout Kill

**Version / slug:** `sessionmgr-activity-aware-timeout`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** _self-audit appended below_

## Summary of the change

The SessionManager monitoring loop's wall-clock-age timeout-kill is now gated on a true-idle check. Pre-fix, a session whose `startedAt` was past `maxDurationMinutes + 20%` got killed unconditionally — even if it was actively producing tool calls. That reaped long-running autonomous flows (spec convergence loops, multi-phase `/instar-dev` builds driving multiple PRs to merge, multi-hour `/loop` tasks) and took their background sub-agents with them. The fix reuses the existing idle-detection helpers (`captureOutput` + `IDLE_PROMPT_PATTERNS`, `hasActiveProcesses`) as a precondition: a session is only timeout-killed when it is over the age limit AND truly idle. Sessions that are over the age limit but still working are deferred until they go idle, at which point the existing idle-detection block below catches them. A new per-session log set (`overAgeButActiveLogged`) ensures the deferred-kill warning fires once per session, not every tick. Files touched: `src/core/SessionManager.ts` (the timeout block at lines 466–525 of the post-fix file), `tests/unit/session-timeout-activity-aware.test.ts` (new), `upgrades/NEXT.md`, `upgrades/side-effects/sessionmgr-activity-aware-timeout.md`. No schema or interface changes; `maxDurationMinutes` and `spawnSession` are byte-identical.

## Decision-point inventory

- `SessionManager.monitor.timeout-kill` — **modify** — kill is now gated on (age > limit) AND (truly idle). Same kill code path; an additional precondition was added. No new authority introduced; existing detector (`captureOutput` + `hasActiveProcesses`) feeds the existing kill decision.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new over-block surface. The fix REMOVES an over-block: before the fix, a session producing tool calls past its age limit was reaped (false positive "zombie" classification). After the fix, that same session is correctly classified as working.

The fix cannot over-kill (sessions doing work are no longer killed at the age boundary). It can only defer kills that would have been correct on rare boundary cases — e.g., a session at exactly the moment of producing its last tool call before stopping. Those cases are caught one tick later by the idle-detection block below; the worst-case delay is the existing `IDLE_PROMPT_KILL_MINUTES` window, which is already the established budget for "session has stopped working."

## 2. Under-block

**What failure modes does this still miss?**

The fix relies on `captureOutput` and `hasActiveProcesses` to signal activity. Two cases the fix does NOT catch:

1. A session that is in a tight LLM-side loop with no terminal output and no child processes (pathological case). The idle-detection block would also miss this, so the fix is no worse than the prior behavior here.
2. A session that has truly hung but happens to have a non-baseline process from `playwright-mcp` or similar (which `BASELINE_PROCESS_PATTERNS` was supposed to exclude). If the exclude list is incomplete for a particular MCP, that's a separate bug in `hasActiveProcesses`, not introduced by this fix.

Neither case represents a new under-block introduced by this PR.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `SessionManager` already owns three signals (terminal output, process tree, wall-clock age) and one decision (kill / don't kill). The fix combines two of those signals (output + process tree) as a precondition on the third (age). This is *the* lifecycle authority for tmux sessions — no other layer is positioned to make this decision.

Lower-level alternative (move the check into a separate "ActivityProbe" class) would add a class without changing the semantics. Rejected — fits Justin's memory rule "Three similar lines is better than a premature abstraction."

Higher-level alternative (add a commitment-registry consultation before any kill) is on the roadmap but out of scope for this PR — documented in NEXT.md.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface that hasn't always existed; the SessionManager.monitor.timeout-kill authority is unchanged. The fix tightens the precondition.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

`captureOutput`, `IDLE_PROMPT_PATTERNS`, and `hasActiveProcesses` are detectors (pattern matchers + process tree inspection). They are NOT blockers; they signal "session looks idle" or "session looks busy." The timeout block consumes those signals to gate its existing kill decision. No new authority surface; the existing wall-clock-age authority got a tighter precondition.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The new gate runs BEFORE the existing idle-detection block (lines 504+ in the post-fix file). If the new gate defers the kill, control falls through to the idle-detection block, which can then catch the session if it actually IS idle. Verified by the regression test "does not skip idle-detection when deferring the timeout kill."
- **Double-fire:** Cannot happen. The timeout block uses `continue` only on the actual kill path; the deferred-kill path falls through. The idle-detection block makes its own kill decision based on its own state (`idlePromptSince` map). Both can fire on the same session in different ticks; only the first to fire wins (state update + `continue`).
- **Races:** None new. The `overAgeButActiveLogged` Set is local to the monitor loop's process and not shared across instances. The captureOutput / hasActiveProcesses helpers are the same ones the idle-detection block uses; no new shared state.
- **Feedback loops:** None. The fix observes session state passively; it does not inject anything into the session.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Other users of the install base:** behavior change is visible — sessions past the age limit but actively working continue running. This is the intended observable improvement.
- **External systems:** none.
- **Persistent state:** none. `overAgeButActiveLogged` is in-memory only.
- **Timing/runtime conditions:** The fix introduces a hidden tick-loop dependency: a session that becomes idle exactly at the moment of the next monitor tick will be killed by either branch with the same end state. The state ordering does not produce observable differences.

The deferred-kill warning is new operator-visible output. Format: `Session "X" is past the age limit (Nm > Mm) but is actively working (procs=Y, idleAtPrompt=Z). Deferring kill; the idle-detection block will catch it once it stops producing work.` Fires once per session (deduped by `overAgeButActiveLogged`).

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the PR, ship as a patch release. No persistent state, no schema migration, no user-visible regression during rollback. Pre-fix behavior is restored byte-identically by reverting `SessionManager.ts` to its pre-PR state.

If the fix turns out too generous (sessions hanging while still appearing "busy"), the existing idle-detection block's `IDLE_PROMPT_KILL_MINUTES` still bounds the worst-case retention. The hard fail-safe is the existing protected-sessions list, which can be used to opt specific sessions out of the new behavior.

---

## Conclusion

This is a minimal-surface-area fix to a real failure mode that has been observed in production (the topic-9529 session that was driving the INSTAR-JOBS-AS-AGENTMD spec convergence + Phase 1 build was killed twice by the unconditional 240m wall-clock check, both times taking its in-flight background sub-agent with it). The fix uses the existing idle-detection signals as a precondition on the existing kill authority — no new gate, no new signal, no new blocking authority. The behavior change is observable as "long-running working sessions are no longer reaped on wall-clock age alone."

Out of scope for this PR (documented as follow-up in NEXT.md): (a) commitment-registry consultation before any kill, (b) orphan-handoff manifests on kill, (c) resume orientation that surfaces orphan-handoff manifests on session respawn. Each is its own substantial change with its own decision-point surface; they belong in their own /instar-dev cycles.

---

## Second-pass review

**Reviewer:** echo (self-audit; no Spawn tool available in this environment to dispatch an independent Opus subagent)
**Independent read of the artifact: concur**

Re-reading the artifact against the actual diff: every claim is traceable to a specific source line in `src/core/SessionManager.ts` and a specific test assertion in `tests/unit/session-timeout-activity-aware.test.ts`. The "deferring kill falls through to idle-detection" claim is the most load-bearing — verified by the regression test that confirms no `continue;` between the defer log and the closing brace. Signal-vs-authority compliance is genuinely clean: this PR adds zero new gates, zero new authorities; it tightens a precondition on an existing kill authority by consulting two existing detectors.

The one residual concern is test coverage. A behavioral test that spins up a real `SessionManager`, injects a fake session record, mocks `captureOutput` / `hasActiveProcesses`, and asserts the kill is deferred would be stronger than the source-text checks in `session-timeout-activity-aware.test.ts`. The existing `session-timeout.test.ts` uses the same source-text-check pattern, so this PR is consistent with the established convention in this repo — not raising a new bar — but the convention itself is weaker than it should be. Flagged for a future test-hardening cycle.

No design concerns. Concur the change is clear to ship.

---

## Evidence pointers

- Source: `src/core/SessionManager.ts` lines 466–525 (post-fix, the timeout block with the new activity gate).
- Field declaration: `src/core/SessionManager.ts` lines 168–173 (the `overAgeButActiveLogged` Set with docstring).
- Tests: `tests/unit/session-timeout-activity-aware.test.ts` — 6 new test cases.
- Regression coverage: `tests/unit/session-timeout.test.ts` (4 pre-existing tests) and `tests/unit/session-manager-behavioral.test.ts` (22 pre-existing tests) — verified passing locally on this branch.
- Failure mode observed: server.log entries showing `SessionManager] Session "instar-jobs-as-agentmd" exceeded timeout (288m > 240m). Killing.` killing the parent session driving INSTAR-JOBS-AS-AGENTMD Phase 1 work, twice (2026-05-12T20:43:37Z and 2026-05-13T01:47:37Z). Both kills took the in-flight Phase 1b sub-agent with them.
