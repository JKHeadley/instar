# Side-Effects Review — refresh refusal hints the tmux name for a dead-but-bound session

**Version / slug:** `refresh-display-name-hint`
**Date:** `2026-10-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see bottom)`

## Summary of the change

`SessionRefresh.displayNameHint` (`src/core/SessionRefresh.ts`) appended a "looks like a display name — pass the tmux session name instead" hint to a refusal only when a RUNNING session carried the given display name. A dead topic session refreshed by its display name therefore came back `not_telegram_bound` with the bare "checked in-memory + disk registry" wording and no hint. On the Mama PC (2026-10-22, topic 127831) that was read as a lost binding; the binding was intact and the dead-bound respawn under the tmux name would have resumed the conversation. The hint now considers sessions of every status: a tmux name with any non-terminal record is "running"; a tmux name with only terminal records is named only when `deadBoundTopic()` still resolves it (the topic still maps to it, so the hinted name works). The running-only wording is byte-identical to before. Files: `src/core/SessionRefresh.ts`, `tests/unit/SessionRefresh.test.ts`.

## Decision-point inventory

No decision-point surface. The refusal codes, the kill/respawn behavior and the rate/work gates are untouched; only the text of an already-issued refusal changes.

## 1. Over-block

Not applicable: nothing new is refused. The refusal existed before; it now carries a more accurate message.

## 2. Under-block

Not applicable (no allow/block surface). Stated limits: the hint still does not remap a display name to a tmux name (EVO-025's deliberate choice; display names are not unique). A dead session whose topic has moved to another session gets no hint, by design, since refreshing it would return `session_not_found`. Two further limits (second-pass review): a `starting` record is counted live and labelled "running" although `resolveTarget` matches only `running`, so refreshing it immediately can give a transient `session_not_found`; and once retention prunes the finished record (killed/failed after 60 min, completed interactive after 24 h) the display name is no longer discoverable, so the hint goes silent even though the dead-bound respawn under the tmux name still works.

## 3. Level-of-abstraction fit

Right layer: the message is built where the refusal is decided, next to `deadBoundTopic()`, the same predicate the route uses to decide whether a dead session can be respawned. No new lookup or registry read is introduced; `listSessions()` (all statuses) replaces `listSessions({ status: 'running' })`, and `deadBoundTopic()` is reused as-is.

## 4. Signal vs authority compliance

Not applicable: no detector, gate or authority added or changed (`docs/signal-vs-authority.md` reviewed). The hint is advisory text.

## 5. Interactions

- `precheckRefusal()` and `refreshSession()` share `resolveTarget()`, so both paths carry the same hint; nothing is killed before the refusal (verified by the existing test that `killSession` is not called).
- `deadBoundTopic()` is now called from inside a refusal builder for each dead tmux name that matches the display name. It has no side effects and no rate budget, but it is not free: per dead candidate it may re-read the registry file from disk, and for a candidate that still resolves to a bound topic it shells out to tmux synchronously (`has-session` and `display-message`, 5 s timeouts each) on the request thread. Bounded by the retained-record cap (~50 finished records) and only on a refusal that was already being issued, so acceptable (second-pass reviewer's cost note).
- Cost: `listSessions()` over the retained records (bounded by the session-retention cap, 50 finished records) on a refusal path only. Not on the hot path.
- The existing route test fixes the running-only message as a mocked string; that wording is unchanged.

## 6. External surfaces

The `error` string of a 409 `not_telegram_bound` / `session_not_found` refusal from `POST /sessions/refresh` can now be longer and mention `GET /sessions?include=all`. No new field, code or status. Visible to agents and operators calling the route; no Telegram message is sent by this path.

## 7. Multi-machine posture

Machine-local BY DESIGN: a refresh addresses a session on the machine that received the call, and the hint is built from that machine's own session records and registry. No replicated state, no notices, no URLs.

## 8. Rollback cost

Trivial: revert the one method. No state, config or migration involved.

---

## Second-pass review

Concur with the review. I read the diff, the full `SessionRefresh.ts`, `StateManager.listSessions`, `SessionStatus`, `TelegramAdapter.resolveTopicForSessionFromDisk`, `SessionManager.isSessionAlive`/`tmuxSessionExists`, and the `POST /sessions/refresh` route. (a) The method is still only interpolated into the message strings of the three existing refusals (`respawnDeadBound`, and twice in `resolveTarget`); no code, status, kill or respawn branch reads its result, and every call it makes is guarded (`resolveTopicForSessionFromDisk` try/catch, `tmuxSessionExists` try/catch, `isSessionAlive` try, `getSessionForTopic`/`getTopicForSession` are map reads, `listSessions()` with no filter returns shallow copies of the cached array), so it cannot throw. (b) `deadBoundTopic` is side-effect-free, but the artifact's "pure read" undersells its cost: for each dead candidate it may read the registry file from disk and, for a candidate that resolves to a bound topic, shells out to tmux synchronously twice (`has-session`, `display-message`, 5 s timeouts each) on the request thread — bounded by the retained-record cap (~50) and only on a refusal, so acceptable, but worth stating. (c) The hint's predicate is exactly the route's: a tmux name passed directly resolves its topic in `resolveTarget`, falls to `session_not_found`, and the route then calls `deadBoundTopic` and respawns, so a hinted dead-bound name does work; two edge cases are unstated — a `starting` record is counted live and labelled "running" although `resolveTarget` matches only `running` (refreshing it immediately yields a transient `session_not_found`), and once retention prunes the terminal record the display name is no longer discoverable, so the hint goes silent even though the dead-bound respawn under the tmux name would still succeed — a stated limit, not a defect. (d) The dedupe is correct: the Map ORs `!terminal` across all records per tmux name, so one running record among several finished ones yields a single "running" entry, and the mixed-status test covers it. (e) Beyond the two edge cases and the cost nuance above, the eight answers hold; the running-only wording is byte-identical and the mocked route-test string is unaffected.

**Author response:** the cost note is now stated in §5 and both edge cases in §2. No code change: the `starting` label is a transient of a session that is seconds from `running`, and the retention window is the existing records' lifetime, not something this hint should extend.
