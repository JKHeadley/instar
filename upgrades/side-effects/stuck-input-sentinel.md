# Side-Effects Review — Persistent Stuck-Input Sentinel

**Version / slug:** `stuck-input-sentinel`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose subagent` *(required: sentinel terminology + session-lifecycle interaction)*

## Summary of the change

Adds `src/core/StuckInputSentinel.ts`, a long-lived periodic worker that runs alongside `SessionManager.startMonitoring()`. Every `tickMs` (default 10s) it scans every running session, captures the bottom of the tmux pane, and decides whether the prompt holds unsubmitted text. If the same text persists across two ticks (≥20s with defaults) AND the pane shows no working indicator, it fires the same escalating recovery the in-process `verifyInjection` uses (`SessionManager.fireStuckInputRecovery`) — Enter, Enter, C-m, Enter+sleep+Enter — bounded at four attempts per stuck event. Each fire writes one row to `<stateDir>/stuck-input-events.jsonl` for operator audit and DegradationReporter consumption.

This is the durable backstop for PR #159 (v0.28.92). The in-process polling schedule (500/1500/3500/6500ms) sits entirely inside a single server process. A crash inside that 6.5s window — exactly what happened on echo 2026-05-11 during the better-sqlite3 ABI-rebuild loop that put the server in a 30+ minute restart cycle — drops every armed timer with no recovery. The sentinel re-attempts recovery from a fresh state on every restart, so the window of "stuck and undetected" is bounded by the tick interval rather than by the crash schedule.

**Files touched:**
- `src/core/StuckInputSentinel.ts` (new, 290 lines)
- `src/core/SessionManager.ts` (visibility change: `isMarkerStuckAtPrompt` and `fireStuckInputRecovery` `private` → public so the sentinel can reuse them without inheriting from SessionManager or duplicating logic)
- `src/commands/server.ts` (instantiate the sentinel after `sessionManager.startMonitoring()`; stop it during the shutdown handler)
- `tests/unit/StuckInputSentinel.test.ts` (new — 20 behavior tests)
- `tests/unit/session-injection-verify.test.ts` (regex regression: the previous test asserted the `private` keyword in the recovery helper definition; updated to match either visibility)

## Decision-point inventory

- `StuckInputSentinel.evaluateSession` — **add** — decides "does this pane look stuck right now?" (text-at-prompt + no working indicator + persistent across ticks)
- `StuckInputSentinel.fireStuckInputRecovery` *(delegated)* — **pass-through** — reuses the existing `SessionManager.fireStuckInputRecovery` escalation; not a new authority surface, just a new caller.
- `SessionManager.isMarkerStuckAtPrompt` / `fireStuckInputRecovery` — **modify** — visibility relaxed (private → public). Behavior unchanged.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.**

The sentinel does not gate or filter messages. Its single action surface is `tmux send-keys ... Enter` (or `C-m`) into a pane the SessionManager already owns. The "false positive" failure mode is "Enter pressed against an idle prompt that had no actual text" — and the sentinel's preconditions (extractPromptText returns non-empty AND minTicksBeforeFire elapsed) make this concrete shape essentially impossible: if `extractPromptText` returns empty, the sentinel returns early and never fires.

The closest analog to over-block is "Enter fired during a transient state that wasn't actually stuck." The `isPaneActivelyWorking` guard rejects that case: any pane showing a Claude Code footer activity hint (`esc to interrupt`, `ctrl+t to hide tasks`, `tokens · esc`) is skipped without firing. We deliberately **do not** key on line-start spinner glyphs (`✻ ✶` etc.) because past-tense markers like `✻ Brewed for 14m 11s` and `✻ Churned for 1m 16s` stick around as visible pane content long after the turn finished. Live reproduction on echo's 2026-05-11 stuck sessions (`echo-qalatra`, `echo-exploring-slack-integration`) showed both held a stale `Brewed`/`Churned` line while genuinely idle — keying on the glyph would have caused the sentinel to skip exactly the cases it's meant to recover. The footer hints, on the other hand, are structurally only rendered mid-turn, so they're the precise tell. The min-ticks-before-fire requirement (default 2 ticks, ≥20s) gives `verifyInjection`'s 6.5s window full priority on fresh injections — the sentinel never races with the in-process recovery on the same event.

## 2. Under-block

**No block/allow surface — under-block not applicable.**

What the sentinel _misses_ is recoverable text that takes longer than `maxAttempts * tickMs` to recover (default ≥40s, all four Enter forms tried). After that, the per-session record marks itself `exhausted` and the sentinel stops firing on that exact prompt text until the user types something new. This is intentional: if four escalating recovery forms can't unstick a pane, more of the same won't help, and the user is now in a state where manual intervention is appropriate. The sentinel records the exhausted state to the events log so operators can see what was tried.

The other "miss": panes whose state genuinely needs something other than Enter (e.g., the pane is showing a `[Y/n]` confirmation prompt that ate the injection's Enter and is now waiting for `y`). Pressing Enter against a `[Y/n]` prompt typically takes the default — usually the safe choice. This is the same behavior `verifyInjection`'s recovery has today; not a regression.

## 3. Level-of-abstraction fit

This belongs at the **session-lifecycle layer** (alongside `SessionManager`), not at the messaging layer (Telegram/Slack/iMessage adapters) and not at the per-injection layer (`verifyInjection`).

- Adapter layer is wrong because the bug isn't messaging-specific; any text that arrives at the tmux prompt and never submits is affected, regardless of how it got there.
- Per-injection layer is the existing `verifyInjection` — it owns the fast path (≤6.5s). The sentinel _complements_ it at the slow / restart-resilient path, not replaces it.
- Session-lifecycle layer is correct: the sentinel reads sessions from `SessionManager.listRunningSessions()`, captures via `SessionManager.captureOutput`, and reuses `fireStuckInputRecovery`. It owns one specific recovery concern — "did the prompt accept this Enter?" — and has no other responsibility.

A lower-level primitive worth flagging: the `extractPromptText` heuristic ("text after the last ❯") is brittle to Claude Code TUI changes. If a future Claude Code release replaces ❯ with a different prompt glyph, the sentinel goes silent (no over-fires, just no recoveries). That's acceptable behavior — the sentinel degrades to a no-op, and `verifyInjection`'s existing heuristic is updated alongside. Both heuristics live in code that's easy to find and change together (`isMarkerStuckAtPrompt` and `extractPromptText` are both in `src/core/`).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The sentinel is a **recovery detector with a bounded action surface**. It does not gate messages, does not block any flow, does not produce a 4xx response, does not refuse to dispatch. It produces one `tmux send-keys Enter` at most per tick per session, bounded at four attempts per stuck event, against a pane whose state is unambiguous (text-at-prompt + no working indicator + persistent).

The "Enter" action against a pane that turns out not to be stuck is provably benign: an empty Enter at an idle Claude Code prompt is a no-op. We're not in the "brittle detector with blocking authority" risk category — there is no blocking authority anywhere in this change.

---

## 5. Interactions

- **Shadowing of `verifyInjection`:** the sentinel's `minTicksBeforeFire = 2` (≥20s with default `tickMs = 10s`) sits well past `verifyInjection`'s last attempt at 6.5s, so the two never race on the same event. The sentinel takes over only after the in-process path either succeeded (prompt clear → sentinel never sees it as stuck) or exhausted (prompt still stuck after 6.5s → sentinel picks up at ~20s).
- **Shadowing of `SessionManager.monitorTick`:** independent setInterval, independent `tickInProgress` guard. They share `listRunningSessions` reads but each call is `O(running)` and the data is already cached on the SessionManager. No mutual write contention.
- **Double-fire on the same Enter:** would require `verifyInjection`'s schedule still ticking past the 20s mark, which the schedule does not (max attempt is at 6.5s). Cannot happen by construction.
- **Race with session-killing path:** if a session gets killed between `listRunningSessions()` and the per-session pane capture, `captureOutput` returns null (or throws); the sentinel swallows the error and moves on. The GC step at end of `tick()` drops the record so a respawned session with the same name starts clean.
- **Race with `purgeDeadSessions`:** purge runs once at boot before `startMonitoring`; the sentinel starts only after monitoring is up, so it never sees the pre-purge set.
- **Feedback loop with itself:** firing Enter against a non-stuck pane (false positive) appears at the next tick as a different (or empty) prompt text, which resets the per-session record. The sentinel cannot loop on its own action.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the sentinel only sends keys to tmux sessions this agent's SessionManager owns. Cross-agent tmux interaction is impossible because tmux sessions are namespaced per-agent (`echo-…`, `dawn-…`).
- **Other users:** none — runtime addition with no API surface.
- **External systems:** none — `tmux send-keys` is a local IPC.
- **Persistent state:** new file `<stateDir>/stuck-input-events.jsonl`, append-only, one row per fire. No schema migration; consumers can ignore the file. The file is best-effort — failures to write don't halt the sentinel.
- **Timing/runtime conditions:** the sentinel's effectiveness depends on the server being up at least one `tickMs` past the stuck event. If the server crashes faster than `tickMs` *every* time after a stuck event, recovery never fires. This is a degenerate case — the underlying server crash is the bug, and other mechanisms (lifeline restart counter, manual operator intervention) catch it.

---

## 7. Rollback cost

**Pure code addition. Revert and ship as next patch.**

- No persistent state migration. The JSONL events log is append-only and can simply stop being written.
- No schema changes.
- No agent state repair. Disabling the sentinel mid-run loses no in-flight work — verifyInjection still handles the fast path.
- User-visible regression during rollback: zero. The sentinel only fires Enter against panes the user *wants* to recover; removing it returns to v0.28.92 behavior.

Worst case if the sentinel misbehaves in production: false-positive Enters against idle prompts (no-ops) or against `[Y/n]` confirmations (takes the default). Neither is destructive. A hot-fix that disables the sentinel via early-return at `start()` is a one-line change.

---

## Conclusion

This change closes the architectural hole in PR #159 (v0.28.92): in-process timers don't survive server restarts, and the bug the user reported on 2026-05-11 is _specifically_ that gap. The sentinel is decoupled from injection-time state — it observes panes purely from `captureOutput`, holds state in memory, and recovers from a fresh start on every server boot. The signal-vs-authority principle does not apply because there is no blocking surface; the action surface is one Enter keypress per attempt, bounded.

A second-pass review is required by the skill (sentinel terminology + session-lifecycle interaction). The reviewer should specifically check the `isPaneActivelyWorking` heuristic (does it correctly skip "✶ Running…" panes? does it correctly NOT skip a stale `✻ Brewed for…` past-tense marker?) and confirm that no race with `verifyInjection` can produce double-fires within the 6.5s window.

---

## Second-pass review (if required)

**Reviewer:** general-purpose subagent
**Independent read of the artifact: concur (with two tight-but-acceptable callouts)**

A. Verified clean. `evaluateSession` sets `consecutiveTicks=1` on first sight and returns; firing requires `consecutiveTicks >= minTicksBeforeFire` (=2), so the earliest fire is one full `tickMs` (10s) after first observation. That's safely past `verifyInjection`'s 6.5s window in wall-clock terms — even if a tick fires immediately after server start and observes a prompt that an injection just landed, the second observation is ~10s later, by which point `verifyInjection`'s last attempt has already resolved. (`src/core/StuckInputSentinel.ts:220-236`.)

B. *Originally flagged as tight-but-acceptable; resolved before commit.* After live-testing the sentinel against echo's 2026-05-11 stuck sessions (`echo-qalatra`, `echo-exploring-slack-integration`), both panes held a stale `✻ Brewed for…` / `✻ Churned for…` line — exactly the user-visible failure mode this change is meant to recover. The spinner-glyph branch was removed; `isPaneActivelyWorking` now keys solely on the footer activity hints (`esc to interrupt`, `ctrl+t to hide tasks`, `tokens · esc`), which Claude Code only renders mid-turn. Tests updated: the suite now explicitly asserts that stale Brewed/Churned lines are treated as idle (the previously-mis-flagged case) and that present-tense glyph lines are also ignored unless accompanied by a footer hint.

C. `extractPromptText` iterates bottom-up and picks the LAST `❯` line, which matches Claude Code's TUI invariant (active prompt at bottom). Historical `❯` glyphs higher in scrollback are correctly ignored. For 3+ line wrapped input, only the first wrapped line is read (`lines[i+1]`); this is sufficient as a stability fingerprint across ticks even if it doesn't capture the full wrapped body. Tight-but-acceptable callout: if Claude Code ever wraps such that `lines[i+1]` is whitespace and `lines[i+2]` holds the real content, the prompt looks empty and the sentinel returns null (silent no-op). Low-likelihood under current TUI behavior; flag for re-test on any Claude Code TUI bump.

D. Cross-restart unboundedness acknowledged in §6. Worst case is N+M Enters across a crash boundary (N before, M after); after the first successful Enter the prompt clears and subsequent Enters land on an idle pane (no-op). Cost bounded and benign.

E. `tick()` is fully synchronous; the `try / finally` at `StuckInputSentinel.ts:144-152` resets `tickInProgress=false` even if `tick()` throws. The inner `evaluateSession` also wraps tmux failures locally, so an error there won't escape past the outer finally. Clean.

F. Confirmed pure side-effect surface. The sentinel only delegates to `SessionManager.fireStuckInputRecovery`, which is exclusively `execFileSync(tmuxPath, ['send-keys', …])`. No message gate, no transport-layer block, no 4xx response path. Signal-vs-authority compliance holds.

Net: ship.

---

## Evidence pointers

- Live reproduction: echo's tmux sessions `echo-exploring-slack-integration`, `echo-qalatra`, `echo-threadline-dev` on 2026-05-11 — text-at-prompt with no spinner, no submission, after a server crash-loop window. None of these messages reached the corresponding Claude Code transcripts (`grep -l "start the rewrite now" ~/.claude/projects/-Users-justin--instar-agents-echo/*.jsonl` returns nothing).
- Unit tests: `tests/unit/StuckInputSentinel.test.ts` — 20 passing tests covering extraction, working-state detection, tick lifecycle, escalation order, max-attempts cap, prompt-change reset, prompt-clear reset, session-GC.
- Regression coverage: `tests/unit/session-injection-verify.test.ts`, `tests/unit/session-multishot-recovery.test.ts`, `tests/unit/SessionManager-injection.test.ts` all green after the visibility-relaxation regex update.
- Type-check: `tsc --noEmit -p .` clean.
