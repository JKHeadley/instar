# Side-Effects Review — sentinel escalation self-heal (no silent swallow)

**Version / slug:** `sentinel-escalation-selfheal`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — concern raised, addressed in code`

## Summary of the change

Both `sendConsolidated` closures in `server.ts` (sentinel-notify ~6988, stop-notify ~9689) used `try { telegram.sendToTopic(lifelineTopicId) } catch { return false }`. A deleted lifeline/system topic made every send throw `message thread not found`, swallowed silently — 41 stall/stop escalations black-holed in one day. New helper `src/monitoring/sentinelConsolidatedSend.ts#sendConsolidatedWithSelfHeal(tg, text, log)`: send to the lifeline topic; on failure, log the real error and call the adapter's existing `ensureLifelineTopic()` (recreates a deleted topic + persists the new id), then retry once. Both sites now delegate to it. Files: `src/monitoring/sentinelConsolidatedSend.ts` (new), `src/commands/server.ts` (import + 2 call sites), `tests/unit/sentinel-consolidated-send.test.ts` (new).

## Decision-point inventory

- Sentinel/stop escalation DELIVERY (not a block/allow gate) — **modify** — adds a self-heal + retry + de-swallow around the existing send. No new gating decision; it only changes how a notification is delivered and whether failures are visible.

## 1. Over-block

No block/allow surface — this is a delivery path, not a gate. It cannot reject any input. (Over-block N/A.)

## 2. Under-block

N/A (no gate). Residual delivery risk: if `ensureLifelineTopic()` can't create a topic (non-forum chat, Telegram down), the alert still isn't delivered — but now it returns false WITH a logged reason (previously silent). The SentinelNotifier's own escalation-state handling of a false return is unchanged.

## 3. Level-of-abstraction fit

Correct layer. The fix lives at the escalation-delivery callback where the swallow was, and reuses the adapter's existing `ensureLifelineTopic()` (the right owner of topic lifecycle) rather than re-implementing topic creation. Extracted to a small injected-dependency module so it's unit-testable without a live Telegram (the inline closures were untestable, which is why the swallow shipped).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this has no block/allow surface; it is a delivery mechanism. It adds no authority; it makes an existing best-effort send self-heal and stop hiding failures.

## 5. Interactions

- **Shadowing / double-fire:** retries the send at most once, and ONLY when the first error matches a topic-gone signature (`message thread not found` / topic deleted/closed / chat not found) — the only case where the message definitely did NOT land. A transient/other error (e.g. 429, network blip that may have landed at Telegram before the response was lost) is NOT retried — it logs and returns false, and the sentinel re-escalates on its next sweep. This eliminates the double-post window: a blind retry would NOT be caught by the `/telegram/reply` ~15-min content-dedup, because this helper calls `sendToTopic` directly (bypassing that route). No loop.
- **ensureLifelineTopic side effect:** it creates a Telegram topic + persists `lifelineTopicId` (via `persistLifelineTopicId`). This is the SAME self-heal it already performs on startup; invoking it on send-failure is the intended use ("called on startup and can be called periodically"). It runs only on a failure path (rare), so no topic-creation spam.
- **Two call sites, one helper:** both sentinel-notify and stop-notify now share identical, tested behavior (previously duplicated inline). No behavior divergence.
- **Races:** the helper is stateless; `ensureLifelineTopic` owns its own concurrency. No new shared state.

## 6. External surfaces

- **Users:** ships to the install base via normal release. Visible effect: system escalations (session-quiet, session-stopped) now actually arrive even if the Lifeline topic was deleted, and never silently fail. A recreated Lifeline topic appears once if the old one was deleted (expected, one-time).
- **Persistent state:** `ensureLifelineTopic` persists the new `lifelineTopicId` — same as its existing startup behavior. No new state shape.
- **Telegram:** one extra API call (`ensureLifelineTopic`) only on a send failure.

## 7. Rollback cost

Pure code change (new module + 2 call-site swaps), no migration. Back-out = revert; behavior returns to the prior silent-swallow. Low. (The original incident — a dead topic 2 — self-heals on the first escalation after deploy; no manual topic surgery needed.)

## Conclusion

A focused robustness fix: it converts a 100%-silent escalation-delivery failure (dead lifeline topic, error swallowed) into self-heal-and-retry with full logging, reusing the adapter's existing topic-recreation. No gating surface, signal-vs-authority compliant, no migration. It is the foundation for the follow-on work the operator requested (route stall alerts to the stalled session's own topic + confidence-gated auto-recovery of the session) — tracked separately. Because it touches the messaging-escalation delivery path, a Phase-5 second-pass review is requested.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concern raised → addressed in code**

The reviewer confirmed the self-heal flow is correct on all 7 paths (happy path doesn't call ensureLifelineTopic; dead-topic heals+retries on the new id; no-topic-configured establishes one; all three failure modes return false + log, never throw to the caller; bounded single retry; both call sites converted with the old swallow gone; tsc-clean type compatibility; ensureLifelineTopic only on failure). It raised ONE valid concern: the original artifact claimed the ~15-min `/telegram/reply` content-dedup covered the partial-send-then-throw duplicate window, but this helper calls `sendToTopic` directly and bypasses that dedup — so a blind retry on a transient (non-topic-gone) error that had actually landed could double-post one escalation. **Addressed in code** (the reviewer's recommended belt-and-suspenders): the retry is now gated on an `isTopicGone(err)` signature check — only deleted/closed-topic errors (where the message definitely didn't land) self-heal + retry; transient errors log + return false (no retry), recovered by the next sentinel sweep. Eliminates the duplicate window entirely. New test case `transient (non-topic-gone) send error → does NOT retry` pins it (exactly one send attempt, ensureLifelineTopic not called). 7/7 helper tests green; tsc clean.

## Evidence pointers

- Live: `logs/sentinel-events.jsonl` — 41 × `notify-error: sendConsolidated returned false` paired with `active-silence`/`stop` escalations on 2026-06-09; `POST /telegram/reply/2` → `400: message thread not found`; config `lifelineTopicId: 2` (deleted on Telegram).
- Tests: `tests/unit/sentinel-consolidated-send.test.ts` (6 cases, both sides incl. all failure modes). tsc + lint clean. (15 unrelated A2A/SessionActivity sentinel test failures are pre-existing on main, verified by stash-compare.)
