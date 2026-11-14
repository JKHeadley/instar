# Side-Effects Review — app sends into a Telegram topic this machine shows

**Version / slug:** `telegram-topic-known-for-app-sends`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 7 files, about 120 lines. Bug topic 10000002678 (feedback fb-26f37ed0-74f): Justin sent a photo and text into Luna's "Email Check - Justin" Telegram topic (534) from the app and got "This conversation no longer exists on the agent." The serving Mac Studio held the topic's history (it posts job notices there), and the app's history read serves any topic with local history, but the write paths only accepted topics in `getAllTopicMappings()` (named here or bound to a session here). Topic 534 had only been named on the laptop.

New helper `src/messaging/telegramTopicKnown.ts`: a topic is known when it is in the mappings, or `getTopicHistory(topicId, 1)` returns a row. It replaces the old check at all five write-path sites: text send (`mobilePairingRoutes.ts`), media upload (`telegramTopicExists`), pins (`exists`), read marks (`exists`), and "open session" (`conversationKnown`). The `JobScheduler` machine-scope notice (main's plain wording from #3105) now names this machine, the pinned machines and the fix. No spec: Tier 1, a narrow bug fix fully undone by a revert. Effort: one review round, one commit attempt.

## Decision-point inventory

- Existence check before an app write into a Telegram topic: widened from "named or session-bound here" to also "has history here". The per-device access checks (`deviceMayUse`, team grants) at each site are unchanged.
- Continuity notice wording: text only; when and whether it fires is unchanged.

## 1. Over-block

The remaining refusal is a topic with no name, session or history on the serving machine. A topic created on a peer, never posted to from the serving machine and never written to by anyone since, is still refused. The serving machine polls Telegram, so any inbound message in that topic gives it history; only an outbound-only topic on a peer stays refused. Rare, and the old rule refused it too.

## 2. Under-block

A topic deleted in Telegram that still has log rows counts as known. A send then fails at Telegram instead of a 404. The old rule had the same gap, because names and session bindings outlive deleted topics.

## 3. Level-of-abstraction fit

One helper in `src/messaging/`, used by every write path and wired in `AgentServer`/`mobilePairingRoutes`. It reads the same history the history route serves, so read and write now share one notion of "this topic exists here".

## 4. Signal vs authority compliance

The check is an existence fact, not a judgment, and the change only narrows refusals. No new blocking authority.

## 4b. Judgment-point check

No competing-signals decision.

## 5. Interactions

- `getTopicHistory` on a miss does one full scan of the message log for that topic id and caches the result (an empty array for an unknown id). `GET /telegram/topics/:topicId/messages` already does the same for any id with no rate limit, so the new sites add no new exposure. Mapped topics never reach the scan.
- Text send is rate-limited (20/min per device) before the check; read marks have their own bucket; upload start needs a signed device request.
- Fakes that only implement `getAllTopicMappings` keep the old behaviour (`getTopicHistory` is optional in the helper's interface).

## 6. External surfaces

Fewer 404 `unknown-topic` / `unknown-conversation` answers to the app. Notice text changes for pinned jobs. No new routes or config.

## 7. Multi-machine posture

Machine-local by design: each machine answers from its own mappings and log, and only the serving machine (lease holder) takes app sends. The serving machine receives every inbound Telegram message, so its log is the widest view; widening to it is what closes the cross-machine gap (topic named on a peer, history on the server).

## 8. Rollback cost

Revert the commit. No state, migration or config.

## Conclusion

Ship. Closes the read/write mismatch for every app write path into Telegram topics and makes the pinned-job notice actionable.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose), 2026-11-13

Checked each site keeps its own device access check; cost matches the existing history read (one cached scan per new id; chat and read marks rate-limited, upload needs a signed device request); no write path still uses the old rule (`getAllTopicMappings().some` remains only inside the helper); tests cover both sides. Noted: deleted-but-logged topics count as known (same gap as before), and an empty `machines` list would read "to ," but the scoping check never reaches the notice then.

Concur with the review
