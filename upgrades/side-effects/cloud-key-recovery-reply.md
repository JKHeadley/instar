# Side-Effects Review — cloud key recovery: held messages answered, operator really told

**Version / slug:** `cloud-key-recovery-reply`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer agent` (concurred after fixes)

## Summary of the change

Follow-up to `cloud-key-internal-calls` (#2695), from the 2026-11-04 nimbus bad-key drill (ledger entry "136880 15:30 PST"). Recovery passed, but only one person got an answer, and the person notice said "My operator has been told" when nobody was in the alert channel.

Three fixes:

1. `slack-reply.sh` in a bound Slack session drops a leading channel id (and thread id) instead of sending it as the message. This was the direct cause: the sessions ran `cat <<EOF | slack-reply.sh C0…`, and in session mode any argument became the text, so the channel id was posted and the piped reply was thrown away. The old template's hash is added to `PRIOR_SHIPPED_SLACK_RELAY_SHA256`, so existing agents get the new copy on update.
2. `ClaudeKeyHealth` restarts each stuck conversation with its own prompt (`claudeKeyRecovery.buildKeyRecoveryPrompt`): the held messages quoted (people's messages after the agent's last real reply; the server's own key notices and a bare channel id don't count as replies), and the exact reply command. A Slack prompt carries the `[slack:<channel>]` tag. Then a restart counts as done only when a real reply appears in the conversation. If none appears within 15 minutes, the person is asked once to send again and the miss is reported. The waiting list is persisted, so it survives a server restart.
3. The operator notice counts as delivered only when a person can read it: the Telegram attention topic, a Slack alert channel with an operator in it, or a direct message. On Slack the operators are the authorized people whose user profile is an owner or admin. With no ranked profile, an authorized list of three or fewer stands in. A larger unranked list gets no direct messages, so a team workspace is never mass-messaged. When the alert channel has no operator in it, it is skipped (a post there reaches nobody, and retries would repeat it) and each operator gets a direct message. When its members can't be read, it gets the post and the operators get direct messages too. `deliverOperatorNotice` is a pure function; the SlackAdapter gains `authorizedMembersOf`, `sendDirectMessage`, `getAuthorizedUserIds` and `recentConversationMessages`.

## Decision-point inventory

- Is a conversation answered — add — a real reply from a session of this agent (its own bot user, not any bot; the Slack origin ledger separates a session's reply from the server's own posts such as the standby note, which come from the same bot user) after the restart time. Read from the conversation: the Slack ring buffer, confirmed against Slack itself before "no" (a channel session's top level plus the thread its latest message came from, long threads walked to the end), or Telegram log rows that are not server automation. Only the agent's authorized people count as waiting.
- Ask a person to resend — add — once, after 15 minutes without an answer.
- Is the operator told — modify — now requires a reader, not just a successful post.
- Slack reply script argument parsing — modify — session mode only.

---

## 1. Over-block

Nothing is blocked. The script change only affects bound sessions whose first argument matches `^[CDG][A-Z0-9]{6,}$`. A real reply whose first word is an all-caps Slack-id-shaped token passed as an argument (not piped) would lose that word. That is very unlikely, and the documented form pipes the text through stdin.

---

## 2. Under-block

A conversation that answers late (more than 15 minutes) still gets the resend request. That costs one extra line, and nothing is lost. A conversation respawned a second time within the 15 minutes (a new session name) can't be checked under its old name: it is reported as unchecked, and the resend request may not reach the person. Held messages read straight from Slack in a mention-only channel can include an authorized person's message that didn't mention the agent (the ring buffer marks those, Slack's own history doesn't), so the agent may answer one message too many. A Telegram row with no provenance (legacy) is treated as the agent's reply. The answer check reads the latest 50 messages, so a very busy channel could push the reply out of view and cause a needless resend request.

---

## 3. Level-of-abstraction fit

The prompt, held-message and answer logic is pure and platform-neutral (`claudeKeyRecovery.ts`). Platform reads stay in the server wiring, beside the existing ClaudeKeyHealth deps. The script fix is in the script, where the fault was, so every caller benefits, not only recovery.

---

## 4. Signal vs authority compliance

The answer check is a signal that triggers one fixed message and a degradation report. It kills, restarts and blocks nothing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new judgment point. These are deterministic checks on fixed texts and timestamps.

---

## 5. Interactions

- SessionRefresh: unchanged. The prompt passes through `followUpPrompt`. The Telegram respawn still adds its own `[telegram:N]` tag, so the Telegram prompt carries no tag.
- The Telegram respawn's back-notice (`SESSION_BACK_NOTICE`) is a fixed text, so it is never mistaken for an answer.
- PresenceProxy standby lines on Telegram are `automation` provenance and are excluded.
- The Slack relay installer: a customized `slack-reply.sh` is preserved as before (the hash list only authorizes overwriting known shipped copies).

---

## 6. External surfaces

New Slack API calls: `conversations.members` (once per operator notice), `conversations.open` + `chat.postMessage` (direct messages, only when the alert channel has none of the agent's people), and `conversations.replies`/`conversations.history` (prompt building and answer checks, about once a minute per restarted conversation, for at most 15 minutes). All use scopes the shipped manifest already requests (`channels:read`, `groups:read`, `im:write`, `channels:history`, `groups:history`).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

New person-facing text: "I'm back, but I couldn't pick up what you sent while my sign-in key was broken. Please send it again." It is plain, has no jargon, and is sent at most once per conversation per episode. The direct-message notice reuses the existing operator text.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Per-machine, like ClaudeKeyHealth itself. State lives in the same machine-local `claude-key-health.json`.

---

## 8. Rollback cost

A revert restores the previous behaviour. The `awaiting` field in the state file is ignored by older code. A newer `slack-reply.sh` already installed would stay until the next migration replaced it with a known shipped copy, which is harmless.

---

## Conclusion

Closes the two drill faults: held messages go unanswered after recovery, and "My operator has been told" when nobody was told. The "session reported done" fault is closed structurally: a restart is no longer success, an answer is.

---

## Found after the review

Replaying the drill's message order showed that the server's standby note (":telescope: … is actively working on something") comes from the same Slack bot user as a real reply. Counted as a reply, it would have hidden both held messages and made a restart look answered, which is the drill fault again. `slackConversationLines` now drops bot posts that the origin ledger records as `server-automation`. A test replays the drill's exact sequence.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer agent, one pass over the code diff
**Concurred:** after fixes. Concerns raised and resolved:
1. Thread replies were invisible for channel-bound sessions, causing false resend requests: a channel key now reads all its threads from the buffer, and the inbound thread from Slack.
2. Long threads were read from the wrong end: replies are now walked to the end.
3. "I'm back" could go out while the key was dead again: the answer check runs only while the key works, and a new outage clears the waiting list.
4. Slack's own history dropped the "who counts" filters: only this agent's bot user is the agent, and only authorized people are waiting.
5. Repeated posts to an empty channel, and a mass message to every authorized user: the empty channel is skipped, and only operators get direct messages.
6. A second rename within the wait: disclosed under Under-block.
7. The script ate an all-capital first word: a channel id must now contain a digit (8–11 characters), so `CONFIRMED` is kept.

---

## Evidence pointers

- `tests/unit/slack-reply-session-channel-arg.test.ts`: the real script under bash. Fails on main's script (reproduces the drill), passes now.
- `tests/unit/claudeKeyRecovery.test.ts`: held messages, answer check, prompt, operator delivery.
- `tests/unit/ClaudeKeyHealth.test.ts`: "a restarted conversation must really answer".
- `tests/unit/slack-adapter-operator-reach.test.ts`: new SlackAdapter methods.
- `tests/e2e/claude-key-alive.test.ts`: production wiring, including the operator-only reader filter and the server-post check. First local verify of 476c91ba2 failed here only (the test still expected the pre-review `readersOf`); unit 58000/0 and integration 5753/0 were green.
- Live: drill rerun on a test agent (see the PR).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **Citation**: `tests/unit/self-action-convergence.test.ts` (controller `claude-key-session-refresh`)
- **Enforcement**: `ratchet`
- **How caught**: The refresh brake is unchanged. The new resend request goes out at most once per restarted conversation per episode: an item leaves the waiting list when an answer shows, or after one request at the 15-minute mark, and a new outage clears the list. Operator direct messages ride the existing notice retry, capped at `NOTICE_MAX_ATTEMPTS`, and a channel with no operator in it is no longer re-posted on each retry.
