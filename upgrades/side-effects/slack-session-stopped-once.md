# Side-Effects Review — "session has stopped" notice: once per unanswered message, and never for the agent's own Slack posts

**Version / slug:** `slack-session-stopped-once`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`
**Tier:** 1 (declared). Size: 5 source files, about 140 lines, plus one test file. Effort: one build pass, no spec rounds.

## Summary of the change

A Slack-only agent posted "The session has stopped. Send a new message to start a fresh session with full conversation context." about a dozen times in one channel in one morning. Two defects combined. (1) `server.ts` fed the SessionMonitor a Slack history that marked EVERY channel message `fromUser: true` (three copies of the mapping: StallTriageNurse, TriageOrchestrator, and the SessionMonitor wiring), so the agent's own notice counted as a new unanswered user message and `userExpectsResponse` could never become false. (2) The SessionMonitor's repeat guards (`snap.notifiedAt`, `notificationCooldowns`) are in memory only, so every server restart re-announced the same death.

Fix: `SlackAdapter.isMessageFromUser()` classifies a cached message as a waiting user only when it has no `bot_id`, is not from a `B…` id, is not from the agent's own user id, is from an authorized user, and was not marked `unaddressed` (mention-only chatter the agent deliberately did not take; also marked on the restart replay backfill). If the agent's own id is not yet known the answer is false (safe: no notice). The three `server.ts` mappings use it. Bot messages now carry `bot_id` in the ring buffer. SessionMonitor gains `deadNoticeStatePath` (`state/session-monitor-dead-notified.json`, registered in the state-coherence registry): after each dead notice it records the `lastUserMessageAt` the notice answered; while no newer user message exists, a dead topic is skipped (no notice, no repeat triage). Only a notice whose send succeeded is recorded, so a failed send stays retryable. Load is tolerant, writes are atomic tmp+rename, entries older than 7 days are pruned (same pattern as the persisted context-exhaustion ledger from PR 936).

## Decision-point inventory

- SessionMonitor dead-session notice — modify — adds a persisted "already told about this user message" skip before triage/notice.
- Slack history fed to monitors (`fromUser`) — modify — from "always true" to a classification of who wrote the message.
- No new block/allow on user messages; inbound Slack routing is unchanged.

## 1. Over-block

- A user whose newest message predates the last notice for that topic, and whose session dies again later without them writing anything new, is not told again. That is the intent: nobody is waiting on anything new.
- StallTriageNurse and TriageOrchestrator read the same Slack history for context. They now see the agent's own posts as agent messages instead of user messages, which is the true picture; TriageOrchestrator does act on it: its "compacted with an unanswered user message" pattern and its `reinject_message` action pick the last `fromUser` message. On Slack it could previously classify the agent's own last post as an unanswered user message and re-inject the agent's own text into the session; now it picks only a real user's message.
- A message processed through the ambient "speak" path in a mention-only channel is stored with its text and no `unaddressed` mark, so it still counts. Only silent/unaddressed messages are excluded.
- If Slack's `auth.test` failed and the bot user id is unknown, no Slack message counts as a waiting user, so no dead/idle notice fires for Slack until it is known. This is the safe direction the brief asked for; the inbound path (next user message spawns a session) is unaffected.

## 2. Under-block

- The ledger is machine-local. Two machines both monitoring the same Slack channel could each post once. Multi-machine topic ownership (`isTopicOwnedByPeer`, PR 2349) already keeps a non-owner machine quiet when an online peer owns the topic; this change does not add a second cross-machine path.
- The agent's own Slack posts reach the history only through Slack's echo of them (`message` event with `bot_id`); `sendToChannel` does not write the ring buffer itself. If an echo is missing, the ledger is what prevents the repeat. Messages cached by `getChannelMessagesWithFallback` from the API carry no `unaddressed` mark (a mention-only channel's chatter fetched that way could still count); the restart replay marks unaddressed messages but cannot tell an ambient "speak" message apart, so that rare case reads as not-user (safe direction).
- A user who keeps writing to a session that cannot be respawned gets at most one notice per new message, still limited by the 30-minute cooldown within one server lifetime.

## 3. Level-of-abstraction fit

Right layer. "Who wrote this message" is the adapter's knowledge (it knows its own bot id and the authorized users), so it lives on `SlackAdapter`. "Was this death already announced" is the monitor's own state, so the ledger lives in SessionMonitor beside the existing persisted context-exhaustion ledger and uses the same shape.

## 4. Signal vs authority compliance

The SessionMonitor is a notifier, not a gate on user input. The change only suppresses a repeat of its own outbound notice; it holds no authority over user messages, sessions, or other components. The classification is deterministic identity checks (bot id, own user id, authorized set), not a brittle content heuristic.

## 4b. Judgment-point check

No competing-signals decision point added. Identity checks and a timestamp comparison are floors, not judgment calls.

## 5. Interactions

- Triage: a death already announced no longer re-runs triage every restart (it used to). A new user message re-enables both triage and the notice.
- Context-exhaustion ledger (PR 936) is unchanged and separate.
- Inbound Slack: the next real user message to a dead channel session goes through the unchanged inbound handler, which finds the registered session not alive and spawns/resumes a fresh one. So a real user is still served; the notice is not the only signal.
- Telegram: history `fromUser` was already correct; the persisted ledger applies, and with it one deliberate change shared by every adapter: after a restart, a death that was already announced (no newer user message) no longer re-runs mechanical recovery or triage. Before, each restart re-ran triage for it. The user was already told to send a new message, and a new message re-enables recovery, triage and the notice. Telegram reuses a topic's session name across respawns, so the ledger is keyed on the user message, not the session name — a later genuine death after a new user message is still announced.

## 6. External surfaces

User-visible: fewer repeated notices in Slack channels and Telegram topics. New state file `state/session-monitor-dead-notified.json` (registered). No API, config, or template change; nothing for `PostUpdateMigrator` to migrate (the file is created on first notice).

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN. The ledger records what THIS machine's monitor announced. Which machine may announce at all is already decided by the session-ownership registry via `isTopicOwnedByPeer`; replicating this ledger would duplicate that authority. One-voice gating for this notice therefore stays with ownership.

## 8. Rollback cost

Revert the commit. The leftover state file is ignored by older code. No migration, no data repair.

## Conclusion

Ship. Removes a self-re-arming notice loop on Slack and makes the notice restart-safe for every adapter, with tests that fail on the previous code.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context)
**Independent read of the artifact: concern (minor, all addressed)**

Raised: (1) the ledger recorded a notice even when the send failed — fixed, recorded only on success, with a test; (2) post-restart triage is skipped for an already-announced death on every adapter, Telegram included — now stated in §5; (3) own posts reach history only via Slack's echo — now stated in §2; (4) restart-replay messages lost their `subtype`, so a join by an authorized user could count — fixed, `subtype` stored and non-`file_share` subtypes are not-user, with a test. Confirmed: ledger keying on the user-message timestamp is correct for both adapters; the inbound Slack handler is untouched and still spawns a fresh session for a real user's next message.

## Evidence pointers

- Live agent (read-only inspection on its machine, 2026-11-02): one machine in its registry (no second Slack server); about 69 server starts since the evening of 2026-10-31, driven by auto-apply updates (`[AutoUpdater] ... autoApply: true`); Slack `respondMode=mention-only`; the affected channel is registered to a tmux session that no longer exists; no new inbound message in that channel on Nov 1–2. Each boot's missed-message replay refilled the channel history with older human chatter, all of it counted as a waiting user, so each boot could post the notice again (the 3:23→3:26 and 2:33→2:46 pairs are inside the 30-minute cooldown, which a restart wipes). Individual notices are not logged, so a one-to-one boot↔notice match was not possible.

- `tests/unit/session-monitor-dead-notice-once.test.ts` — 12 tests; they fail on the previous code (the opt-out and newer-message cases pass on both), all pass after.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — not an agent-authored-artifact defect; the change modifies a self-triggered notifier (SessionMonitor notify), so the convergence argument: control-loop edge = monitor poll → notice → (Slack echo of the notice) → history. The fix cuts the edge (own posts never count as user messages) and adds a steady-state bound: at most one notice per distinct user-message timestamp per topic, persisted across restarts. Settling brake: existing 30-minute cooldown plus the ledger.
- **`closure`** — guard: `tests/unit/session-monitor-dead-notice-once.test.ts` (ratchet; "many restarts with no new user message post exactly one notice in total" would have caught this defect).
