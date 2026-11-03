# Side-Effects Review — the unanswered-message watcher follows the replacement session

**Version / slug:** `presence-follows-replacement-session`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent (read-only diff review)`

## Summary of the change

Tier 1: a narrow fix to one monitor that a revert fully undoes. Files: `src/monitoring/PresenceProxy.ts`, `src/commands/server.ts`, a new unit test file.

The PresenceProxy (the tiered "standby" watcher on an unanswered message) recorded the session name once, when the user message was logged. Slack and Telegram log the inbound message before they find the old session dead and spawn a replacement. So the watcher kept the dead name, read it dead at Tier 1 (20 s), jumped to the Tier 3 dead branch and posted "5-minute check — The session appears to have stopped" about 30 s in, while the replacement worked (indra, Slack, 2026-11-03).

1. `refreshSessionName()` re-resolves `getSessionForTopic` before every liveness read in `fireTier` and `fireTier3`, and follows a replacement. The pre-message baseline is dropped on a switch because it belonged to the old pane.
2. New optional dep `isSessionStarting(topicId)`. On Slack, `server.ts` keeps an in-flight counter per channel around `spawnInteractiveSession`, decremented in `finally`. On Telegram it reads the existing `SpawningTopicsRegistry`. While it reads true and less than the Tier 3 delay has passed, the dead alarm is held and the same tier re-runs after the Tier 1 delay.
3. A dead reading at Tier 1 re-checks at the Tier 2 mark instead of jumping to Tier 3.
4. `tier3Label()`: "5-minute check" only when at least 90% of the Tier 3 delay has passed, otherwise "Check". An early real death says "The session handling this conversation has stopped, and no new session has started for it."

## Decision-point inventory

- PresenceProxy dead-session branch: **modify**. It now waits (until Tier 2, or while a spawn is in flight, capped at Tier 3) before taking the dead path, and it resolves the current session name first.
- Tier 3 message label: **modify** (wording only).

---

## 1. Over-block

The watcher has no block authority. It only decides whether to post a status line. The new holds delay a real dead-session report from about 30 s to about 2 minutes, or to at most the 5-minute mark while a spawn is in flight. That is the intended trade.

## 2. Under-block

- A spawn that hangs past 5 minutes is reported at the 5-minute mark as "5-minute check — The session appears to have stopped". That is accurate.
- If the old session is still listed as alive but is not answering (stuck), this change does not alter detection. The live-session tiers run as before.
- Slack thread sessions: the counter is keyed by the parent `channelId`, which is what the proxy's synthetic id maps to. A thread spawn therefore holds the channel's watcher too. That only widens the "starting" hold for the same channel, capped at Tier 3.

## 3. Level-of-abstraction fit

The fix lives in the watcher. It already owns the "is anyone answering" judgment and already gets the registry lookup (`getSessionForTopic`). Re-ordering the server's inbound path (spawn before logging) would touch every adapter and the message-log contract. The spawn signal reuses Telegram's existing registry rather than adding a second one.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. It changes when and with what words a status message is sent.

## 4b. Judgment-point check

No new heuristic at a competing-signals point. "Which session is registered now" and "is a spawn in flight" are facts the server records.

## 5. Interactions

- **Triage mutex:** `fireTier3` re-resolves before acquiring the mutex. If the name changes during its 5 s re-check, it releases the old name's claim and acquires the new one, so the mutex stays balanced.
- **SessionMonitor "The session has stopped" (PR 2601):** a different component. Untouched.
- **Race guard / agent reply:** unchanged. Every hold returns through `scheduleTier`, which drops a cancelled state.
- **Rate limits:** a held check returns before any LLM call, so the holds spend no LLM budget. The 5 s retry wait runs once per held check.
- **Persisted state:** `persistState` writes the current (possibly switched) name, so a restart restores the replacement.
- **Stand-down / one-voice:** unchanged. All sends still go through `sendProxyMessage`.

## 6. External surfaces

Status-message timing and wording only: "Check — …" instead of "5-minute check — …" for reports before the 5-minute mark. No API, config or schema change.

## 6b. Operator-surface quality

Plain wording, no time claim that isn't true. No new controls.

## 7. Multi-machine posture

**Machine-local by design.** Each machine's watcher reads its own session registry and its own in-flight spawns, exactly like the existing liveness read. One-voice gating (`speakerElection`) is unchanged. No new durable state.

## 8. Rollback cost

Pure code. Revert and ship a patch. No migration, no state to repair.

## Conclusion

This fixes the false alarm at its cause (a stale name plus treating "starting" as "stopped") and keeps the real alarm.

## Second-pass review

**Reviewer:** independent subagent (read-only review of the diff, given the incident and required outcome but not my conclusions)
**Independent read:** concur, with fixes applied

- **Applied (severe):** a Tier 1 skipped on a dead read went to Tier 2 without marking Tier 1 passed. `fireTier2` returns early when `tier1FiredAt` is unset, so Tier 3 was never scheduled. A replacement that later hung would then never be reported. Tier 1's stage is now marked passed on that path, the same as the existing ack-suppressed path.
- **Applied (severe):** a spawn hold ending after the Tier 2 mark ran a late Tier 1 whose time to Tier 2 was ≤ 0, so nothing more was scheduled. `fireTier` now runs the tier that matches the elapsed time once the session is alive. Two new tests cover both cases. They fail on the first version of the fix and pass now.
- **Applied (minor):** the triage-mutex hand-off on a name switch now honours a claim held by the StallTriageNurse, the same as the first acquire.
- **Stated, not changed:** the Slack counter is per channel, so a spawn for one thread holds the channel watcher too. That is capped at the Tier 3 delay and is already listed under Under-block.
- Checked fine by the reviewer: counter balance on every exit path, key match with `slackProxyChannelMap`, registration before the in-flight flag clears (Slack and Telegram), Telegram respawn paths all using `SpawningTopicsRegistry`, the hold loop cap, rate limits, the persisted-state restore, and the single construction site.

## Evidence pointers

- `tests/unit/presence-proxy-replacement-session.test.ts`: 8 tests. The 4 incident scenarios fail on the previous code. The 2 continuation tests fail on the first version of the fix. All pass now.
- Live logs from indra were **not** read: the laptop's Echo server, the only route to indra's files, was down for this whole session. The cause is shown by code reading (`SlackAdapter` logs the inbound before `server.ts` spawns and registers) and by the reproduction test.
