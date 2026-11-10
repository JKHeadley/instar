# Side-effects review — session-start hook reads Claude Code's stdin `source` (compaction recovery actually runs)

**Version / slug:** `cb-compaction-recovery-source`
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 (converged 6 rounds, approved by the operator 2026-11-09 17:22 PST, topic 141133). Phase 0, first slice.
**Tier:** 2 (fleet-wide change to every agent's post-compaction context; spec-driven).
**Change size:** 5 files: `src/core/PostUpdateMigrator.ts` (hook literal), `src/server/routes.ts` (one event branch), `src/config/ConfigDefaults.ts` (one default), `src/commands/init.ts` (comment), two new test files.
**Effort:** 1 build attempt.

## Summary of the change

The installed `session-start.sh` decided "was this a compaction?" from `CLAUDE_HOOK_MATCHER`, which Claude Code (verified in 2.1.321 on two machines: zero occurrences in the binary) never sets; it passes `source` in the hook's stdin JSON. So every event resolved to `startup`, and the branch that execs `compaction-recovery.sh` never ran on any agent. The hook now reads stdin (deadline-bounded to 1 s, never blocks boot), routes on `source`, keeps `CLAUDE_HOOK_MATCHER` as a fallback, and resolves a Claude Code start with no readable source to `unknown`: startup orientation plus a `SessionStartSourceUnknown` event to `/hooks/events`, which the server records as a `compaction-recovery-source` degradation. Non-Claude engines (`INSTAR_FRAMEWORK` set and not `claude-code`) and `contextBudget.compactionRecovery.enabled: false` both keep the old routing decision (the hook still drains stdin and reads config before branching, which is harmless). Config is read from `$INSTAR_AGENT_HOME/.instar/config.json` first, so worktree sessions honour the switch; the port for the unknown-source report comes from `INSTAR_PORT` first. The degradation is reported at most once per server process per hour with a constant reason, so a Claude Code build that drops `source` cannot flood the degradation or upstream-feedback channels.

**L7 evidence (reproduced before/after, real Claude Code 2.1.321, throwaway project, real `/compact`):** with the installed hook, the transcript has a `compact_boundary` entry and **0** recovery blocks; with the new hook, a `compact_boundary` entry and **1** recovery block (marker line from a stub `compaction-recovery.sh`).

## Decision-point inventory

- **Modified:** the session-start hook's event routing (which lifecycle branch runs). Invariant over an enumerable domain (`startup|resume|clear|compact|fork`), no judgment. Unknown is a named outcome, not a guess.
- **Added:** none that blocks or gates. The degradation record is a signal.

## 1. Over-block

None. Nothing is refused; the change only lets an existing branch run.

## 2. Under-block

A Claude Code build that renames or drops `source` falls back to `CLAUDE_HOOK_MATCHER`, then to `unknown` with a degradation record, so the failure is visible rather than silent. The standing canary that counts compactions against recovery blocks is a later Phase 0 slice of the same spec; until it ships, the degradation record is the only signal.

## 3. Level-of-abstraction fit

Right layer: the hook is where Claude Code hands over the event. The degradation goes through the existing `DegradationReporter` via the existing `/hooks/events` route; no new route.

## 4. Signal vs authority compliance

Compliant. The routing is structural (an enumerable field), and the only new server behaviour is a signal (a degradation record). Nothing gains blocking authority.

## 5. Interactions

- `compaction-recovery.sh` now runs after real compactions for the first time on Claude Code agents. It already ships always-overwritten and was written for this branch; its output (identity, soul excerpt, topic briefing, recent messages) is what the hook was meant to inject. It adds context after each compaction, which is its purpose.
- `CompactionSentinel` / `recoverCompactedSession` (server-side payload injection after idle compactions) is unchanged in this slice. On an idle compaction both paths can now deliver context (the hook's block at session start and the sentinel's injected payload). That double delivery is the "two injectors" problem the spec resolves in a later Phase 0 slice (one carrier, seed-success short-circuit); it existed in intent before (the hook was designed to run) and is bounded to idle compactions.
- Codex sessions run the same `session-start.sh`; they keep the old branch, verified by test.
- The hook's stdin read consumes stdin; no later part of the hook or `compaction-recovery.sh` reads stdin (checked).

## 6. External surfaces

Every Claude Code agent's context after a compaction gains the recovery block on the next update. No user-facing message changes. The degradation, when it fires, appears on `/health` like any other.

## 6b. Operator-surface quality

Not applicable: no UI.

## 7. Multi-machine posture

Unified by build: the hook literal and the route are code, identical on every machine running the version; each machine's hooks are always-overwritten by its own `PostUpdateMigrator`. A machine on an older build keeps the old (dead) branch until it updates. The degradation is recorded on the machine whose session started.

## 8. Rollback cost

Set `contextBudget.compactionRecovery.enabled: false` (exactly the old behaviour, no restart needed: the hook reads config per start), or revert the release. No data migration, no state repair.

## Found problems (triage)

- Two post-compaction injectors on idle compactions: blocks nothing now; queued as the spec's own next Phase 0 slice (one carrier). <!-- tracked: CMT-1536 -->
- The CLAUDE.md template sentence "The hooks above handle re-injection automatically" was false while the branch was dead; with this change it becomes true, so no template edit.

## Proportion

Tier 2, 5 source/test files plus artifacts, 1 attempt. In line.

## Revisions after the second-pass review

All three concerns adopted: (1) one report per server process per hour, constant reason, integration test that three POSTs record one degradation; (2) config read from the agent home first and port from `INSTAR_PORT`, unit test that a worktree session with the switch off in the agent home's config does not run recovery; (3) the stdin read stops as soon as the JSON parses, and the switch-off wording above is corrected. Both test files are tracked.

## Second-pass review

(appended below)

**Reviewer:** independent second pass (subagent), 2026-11-09. Rendered hook `bash -n` clean; ran it against a stub project for compact / Codex / switch-off / matcher-fallback / no-stdin / never-closed-stdin cases.

Concern raised: the degradation floods upstream feedback, and the kill switch and degradation both miss worktree sessions.

1. **Feedback flood (blocking).** `DegradationReporter.report()` on the default path (Remediator off) calls `reportEvent()`, which runs `feedbackSubmitter` → `FeedbackManager.submit()` for **every** event. `submit()` does not dedupe (title dedupe sits only in `validateFeedbackQuality`, which `submit` does not call), and the route puts the session id in `reason`, so the feedback title differs every time anyway. On an affected build that is one upstream `[DEGRADATION]` bug per session start, fleet-wide, plus a 500-slot in-memory ring that evicts other degradations. Only the Telegram alert has a cooldown (1 h per feature). **Fix:** keep `reason` constant (no session id; if needed, log the id to console or put it in `context`) and rate-limit in the route, e.g. a module-level `lastSourceUnknownReportAt` with one report per server process per hour (count the suppressed ones in the next report). Add a test that two POSTs produce one feedback submit.
2. **Worktree sessions (major; it breaks the artifact's rollback claim).** The hook resolves config as `${CLAUDE_PROJECT_DIR}/.instar/config.json`. SessionManager's own comment (`INSTAR_AGENT_HOME`, near `-e INSTAR_FRAMEWORK`) says that a worktree session's project dir has no `.instar/config.json`, but it does carry `.instar/hooks/instar/session-start.sh` and `compaction-recovery.sh`. This worktree has both hooks and no config. Reproduced: the switch was set off in `$INSTAR_AGENT_HOME/.instar/config.json`, and `{"source":"compact"}` still ran recovery. So "off = exactly the old behaviour" is false for worktree sessions, and the `SessionStartSourceUnknown` POST never fires there because `SU_PORT` is read from the same missing file. **Fix:** read config from `${INSTAR_AGENT_HOME:+$INSTAR_AGENT_HOME/.instar/config.json}`, falling back to `$INSTAR_DIR/config.json`, and take the port from `INSTAR_PORT`, then that config.
3. **Minor.** (a) "Switch off = exactly old behaviour" is also loose because stdin is still drained, and two python3 spawns run, before the branch. That is harmless, since nothing downstream reads stdin: I checked every `sys.stdin` use in both rendered hooks, and all are fed by `echo`/`printf`. Reword the claim rather than change the code. (b) If stdin is held open without EOF, the read waits for the full 1 s deadline even after a complete JSON arrives (measured about 1.4 s against 0.4 s). Breaking out once `json.loads(buf)` succeeds removes that. (c) A hand-started Codex without `INSTAR_FRAMEWORK` is treated as Claude Code. It routes correctly when Codex supplies `source`, otherwise it emits a mislabelled degradation; this is acceptable. (d) Both test files are untracked (`??`) and must be `git add`ed.
4. **Holds.** Quoting is correct (`$INSTAR_DIR` with no brace does not interpolate in the TS literal; the rendered JSON body is valid, and I captured it on a listener). Stdin cannot block boot: the bound is 1 s, and a closed or `/dev/null` stdin returns at once. The `/hooks/events` branch placement is safe: auth is router middleware upstream, the 503 guard runs first, and the early return only skips the event store for this one synthetic event, which the memory-session guard never needed. Codex keeps the env-only branch, and rollback via config needs no restart, apart from the worktree gap in point 2.

**Second verdict (same reviewer, after revisions):** Concur after revisions. I re-rendered the hook (`bash -n` clean) and confirmed three things. The switch set off in `$INSTAR_AGENT_HOME/.instar/config.json` now suppresses recovery for a worktree session. The open-pipe start drops to about 0.8 s. The route reports at most once per process per hour, with a constant reason. The unit test (8/8) and the integration test (4/4) pass locally. One small caveat: the hourly limit lives in each `createRoutes` closure, so it holds per router instance, which in production is one per server process.

## CI follow-up (three repo-invariant tests)

CI on the first push failed three structural tests, all caused by this change and none by behaviour:

- `native-hook-events-consumers` reads a fixed 2500-character window of the `/hooks/events` route and expects the shared dispatch call inside it. The inline unknown-source block pushed that call out of the window. The block is now a named helper defined above the route, and the route calls it in one line. Behaviour is unchanged (same hourly throttle, same degradation text, same 204).
- `lint-dev-agent-dark-gate` pins the line number of every `enabled:` default. The new `contextBudget` block sat in the middle of the defaults and shifted every later row by 7. It now sits at the end of the shared defaults, so no pinned row moves. The value and its default (on) are unchanged.
- `feature-ladders-coverage` requires the spec's `ladder: contextBudget` line to name a real registry entry. `contextBudget` is added to the ladder registry as `finished`: a default-on bug fix with an ordinary off switch, not a staged rollout. The spec's later fold switches will get real rungs when they ship.

Over-block, under-block and rollback are unchanged from the review above: all three edits are placement or registry edits with no runtime decision added.
