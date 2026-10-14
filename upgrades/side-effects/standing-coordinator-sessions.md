# Side-Effects Review — standing coordinator sessions + dead-topic-session restart

**Version / slug:** `standing-coordinator-sessions`
**Date:** `2026-10-14`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Adds `sessions.standingSessions` (tmux names or `topic:<id>`). `SessionManager.isStandingSession` resolves membership (topic entries via the Telegram binding, wired in server.ts). The shared `ReapGuard` gains a `standing-session` KEEP reason directly after `protected`, so every autonomous `terminateSession` (SessionReaper idle reap, age-limit, sentinel-complete, rerouted lifetime, idle-zombie) keeps it; `terminateSession` lifts only that reason for a `topic moved…` closeout or a verified drained stand-down close. The monitor loop skips the age-limit and completion-pattern checks for standing sessions; `reapCompletedSessions` keeps a live standing session on a completion pattern. `terminateSession` lifts only that reason for trusted, runtime-private assertions: the reaper's post-transfer closeout (`localPostTransferCloseout`), the topic-transfer drain (new `topicTransferClose`), a verified drained stand-down close, and the recovery engine's kill-to-respawn (`recovery-bounce` + `bypassRecoveryFlag`). Separately: `SessionRefresh.respawnDeadBound` + `deadBoundTopic` let `POST /sessions/refresh` respawn a topic session whose process is gone (no kill, no work gate), and `createSpawnForTopic` accepts an optional liveness probe so a dead mapping no longer refuses. Files: `src/core/{types,Config,SessionManager,ReapGuard,SessionRefresh,dashboardTopicProfile,PostUpdateMigrator}.ts`, `src/server/routes.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, tests.

## Decision-point inventory

- `ReapGuard.blockedReason` — modify — new KEEP reason `standing-session` (config-listed sessions only).
- `SessionManager.terminateSession` autonomous guard — modify — bypasses `standing-session` only for trusted private assertions (post-transfer closeout, transfer drain, verified drained stand-down, recovery kill-to-respawn). A reason string is never authority.
- `SessionManager` monitor age-limit + completion checks, `reapCompletedSessions` — modify — skip live standing sessions.
- `POST /sessions/refresh` — modify — a `session_not_found` refusal for a dead, still-mapped topic session becomes a respawn.
- `createSpawnForTopic` — modify — `topic-has-session` refusal only when the mapped session is alive (when a probe is supplied).

---

## 1. Over-block

The new keep only applies to sessions the operator lists. A listed session that genuinely should be closed (truly finished, stuck) is no longer closed automatically; the operator can close or refresh it, and the existing watchdogs that restart (not end) sessions still act. The refresh and create changes remove refusals; no new refusal is added.

## 2. Under-block

- A standing session can still die from a crash, OOM, host reboot or an operator close; nothing here revives it automatically. The resume queue covers reaps, not crashes; after this change the recovery path is an explicit `POST /sessions/refresh` (now works on a dead session) or an inbound message. Supervisory revival of a dead standing session is not added; on the development agent the desk supervisor covers it.
- A standing session under critical memory pressure is kept, by design. The list is meant for one or two coordinators; it is not bounded in code.
- `topic:<id>` membership is resolved through the in-memory Telegram binding; on an in-memory miss only the name match applies (safe direction: less keeping, not more).

## 3. Level-of-abstraction fit

The keep is in the one shared guard every autonomous killer already consults (`ReapGuard`, the ReapAuthority's chain), not a parallel check per killer. The monitor-loop skips exist only to avoid per-tick terminate attempts and reap-log churn; the guard is still authoritative. The dead-session respawn reuses the existing respawner rather than adding a spawn path.

## 4. Signal vs authority compliance

- [x] No — this change has no new brittle block/allow surface over messages or actions.

The new keep reason is an operator-declared list (an explicit instruction, not a heuristic), in the same position and with the same authority as `protectedSessions`. It only removes autonomous kill authority over listed sessions; it never blocks an operator action. The refresh/create changes remove refusals.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The keep is an enumerable operator-declared invariant ("this session is standing"); the dead-session condition is a deterministic liveness fact (no running record, tmux has no session, topic not mapped elsewhere).

## 5. Interactions

- **Shadowing:** `standing-session` sits after `protected` (protected still wins, asserted in tests) and before every activity guard; for listed sessions it shadows them, intentionally.
- **Topic transfer / stand-down:** the reaper closeout, the WS1.2 transfer drain (`topic N transferring to X — …`, which the first draft's `startsWith('topic moved')` missed) and the drained stand-down lift only `standing-session` via explicit private flags; other keep reasons still apply (tested with the drain's real reason string). Without this a standing coordinator could stay live on two machines.
- **Recovery:** SessionRecovery's kill-to-respawn (`recovery-bounce` + the private `bypassRecoveryFlag`) lifts the standing keep, so the recovery path kills through the authority (records `beforeSessionKill`, settles the old record) instead of leaving it to the respawner's raw tmux kill. A public `recovery-bounce` claim does not lift it.
- **SessionWatchdog final level:** `watchdog-stuck` (a terminal kill after the Ctrl+C/SIGTERM rungs fail) is refused for a standing session, by design: a wedged coordinator stays and is restarted through refresh or the desk supervisor rather than ended. The watchdog's earlier rungs, which act on the stuck child process, are unchanged.
- **Resume queue / revival cap:** unchanged. A standing session is no longer reaped, so it no longer feeds the cap.
- **Refresh races:** the dead path takes the same in-flight lock and rate budget as a refresh, and re-checks eligibility immediately before calling the respawner, because the respawner force-kills any tmux session by that name: if an inbound message brought the session back in between, the call answers `session_not_found` and kills nothing (tested). What remains: an inbound spawn that has started but not yet created its tmux session or running record is not seen by the re-check. Claiming the topic in the spawning-topics registry would close that window; the reviewer judged it non-blocking. The rate budget is charged only after the re-check passes.
- **protectedSessions:** unchanged; the bullet steers users away from it for restartable coordinators.

## 6. External surfaces

- New optional config key; absent ⇒ identical behavior to today.
- `POST /sessions/refresh` may now answer `200 { respawnedDead: true }` where it answered `409 session_not_found`; callers that treated 409 as final now see a restart. Only for a dead session whose topic still maps to it (or to nothing).
- `POST /sessions/create` (dashboard) may now spawn where it refused `topic-has-session` for a dead mapping.
- No operator-facing action added that needs a phone surface: the config key is set conversationally by the agent, and refresh is already an agent-callable route.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: the list and liveness checks apply to sessions on the machine that runs them, like `protectedSessions`. The topic-moved closeout explicitly still closes a standing session left behind when its topic moves, so the coordinator follows the topic rather than duplicating. No notices, no durable state, no URLs.

## 8. Rollback cost

Pure code change; revert and ship a patch. The config key is ignored by older versions. No persistent state is written.

## Conclusion

Closes the 2026-10-14 desk outage class: a listed coordinator is no longer closed by cleanup yet stays restartable, and a dead topic session can be brought back by an explicit refresh or a dashboard create instead of only by an inbound message. The revival cap is left as is.

## Second-pass review

**Reviewer:** independent general-purpose subagent (read-only audit of the diff + this artifact)
**Independent read of the artifact: concern → resolved**

- The topic-transfer drain's reason (`topic N transferring to X — …`) did not match the `startsWith('topic moved')` bypass, so a standing session would stay live on both machines after a drain. Resolved: the prefix match is gone; explicit private flags (`localPostTransferCloseout`, new `topicTransferClose` passed by the drain wiring, verified drained close) lift the keep. Tested with the drain's real reason string and with a public "topic moved" reason (still kept).
- Recovery's kill-to-respawn was refused by the new keep (recovery still worked through the respawner's raw kill, leaving the old record `running`). Resolved: `recovery-bounce` + `bypassRecoveryFlag` lifts it. Tested both sides.
- `watchdog-stuck` is now always refused for a standing session. Accepted and documented under Interactions.
- `respawnDeadBound` could force-kill a session an inbound message had just brought back. Resolved with a last-moment re-check (tested).
- Re-check of the fixes: **Concur** (one non-blocking residual race noted under Interactions; the rate charge was moved after the re-check).
- Wiring tests are source checks. Accepted: the behavior is covered by the SessionManager/ReapGuard/SessionRefresh unit tests and the route integration test; the source checks only guard that server.ts keeps passing the real delegations.

## Class-Closure Declaration (display-only mirror)

`defectClass: novel` is not claimed. This change does not fix an agent-authored-artifact defect; it narrows a self-triggered controller (removes the reaper's kill authority over operator-listed sessions) and adds no new self-triggered action. The dead-session respawn is operator/agent-requested through an explicit route, never self-triggered. Not applicable.
