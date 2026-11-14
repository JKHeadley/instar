# Side-Effects Review — the lease holder records the peer replies it delivers

**Version / slug:** `forwarded-reply-holder-history`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1. 1 new source module (`src/messaging/telegram-origin/ForwardedDeliveryHistory.ts`, ~50 lines), 3 touched (`OriginMesh.ts` +15, `TelegramOriginRuntime.ts` +3, `server.ts` +14), 1 new unit test file, 3 new integration cases. One build pass, no spec rounds.

When a standby machine forwards a reply to the lease holder (`handleOriginMesh` `submit`) and the holder's Telegram send succeeds, the holder now derives a history row from the sealed request it already verified (pre-format `policy.text`, else the wire `text`; thread id; Telegram `message_id`; `producerKind`) and hands it to `runtime.options.onForwardedDelivered`. `server.ts` maps the chat (main chat → thread id, issues chat → `10_000_000_000 + thread`) and calls the existing `TelegramAdapter.recordRecoveredOutbound`, the same writer the recovered-forward path already uses. Before, only the sender recorded a forwarded reply, and only on a clean answer; an "acceptance unknown" answer left the delivered reply in no machine's history. That made `reviewQueuedReplyHistory` release a stale held note under a newer question in topic 141868 (2026-11-11 19:41 UTC; Telegram 141952 → 141953), and made the Studio's history show the topic as silent while the M5 session was replying.

## Decision-point inventory

- `allowQueuedRecovery` / `reviewQueuedReply` (overtaken-reply retirement) — pass-through — unchanged code; it now sees holder-recorded rows through the pooled read it already performs, so it can retire a held reply that a forwarded reply overtook.
- Holder `submit` outcome — pass-through — the return value is unchanged on every path; the recorder runs after the outcome is decided and its exceptions are swallowed and logged.

---

## 1. Over-block

No block/allow surface added. The only behavioural consequence is that the existing overtaken check can now retire a held session reply that a newer, delivered forwarded agent reply overtook. That is the check's intended behavior (a newer agent message supersedes a queued older one); it was blind to this case before.

## 2. Under-block

- A forwarded reply whose holder send itself ended `outcome-unknown` still has no Telegram id and is recorded nowhere (by design: only a receipt may create a history row).
- A peer's reply delivered while the holder's pooled read cannot reach the sender, or before the holder recorded it, is still invisible to that sender's overtaken check for that tick. The check waits on failed peers for 15 min (`QUEUED_REPLY_PEER_WAIT_MS`), which covers the common case.
- General-topic (no thread) and non-`sendMessage` forwards are not recorded, which is the same as today.

## 3. Level-of-abstraction fit

Right layer: the holder is the only machine that knows for certain a forwarded reply was delivered (it holds the Telegram receipt). Recording there uses the existing history writer (`recordRecoveredOutbound`) and feeds the existing overtaken check and the existing pooled read. No parallel detector is added.

## 4. Signal vs authority compliance

Complies. The change produces data (a history row) and holds no blocking authority. The decision to retire a queued reply stays with the existing `reviewQueuedReplyHistory`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals decision point. A delivered Telegram receipt is a fact, not a heuristic.

## 5. Interactions

- `appendToLog` fires `onMessageLogged` (topic memory dual-write, summaries) and the `message:logged` event on the holder for these rows. That is the same as for any outbound reply the holder sends itself; the holder now simply knows about agent replies in topics served elsewhere. The holder's presence/standby logic gains a correct "agent replied" signal for such topics.
- Pooled read (`GET /telegram/topics/:id/messages?scope=pool`) dedupes by direction + message id, so a row present on both sender and holder shows once.
- `appendToLog` has its own dedupe key, so a repeat submit (it cannot normally recur; `runFirstSend` is once-only) does not double-write.
- Recovered-forward path (`confirmedRecoveredForward` on the sender) still writes the sender's row; the holder's row is independent and deduped in the pool view.

## 6. External surfaces

Visible effect: the holder's topic history (dashboard, app history, `GET /telegram/topics/:id/messages` without `scope=pool`, bootstrap context of a session later spawned on the holder) now includes agent replies delivered on behalf of peers. No Telegram send, no new route, no config.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched (no dashboard, approval page or form files).

## 7. Multi-machine posture (Cross-Machine Coherence)

This change closes a multi-machine gap. Posture: **replicated at the point of delivery**. The sender records on a clean answer, the holder records on every receipt, and the merged read is the existing pooled history read. Single-machine agents never forward, so nothing changes for them. Status surfaces: none added or changed.

## 8. Rollback cost

A revert fully undoes it. Rows already written stay in the holder's history; they are true records of delivered messages, so leaving them in place is harmless. No migration, no config, no state repair.

## Conclusion

A small history-only change at the one place that holds the proof of delivery. It closes the "delivered but in no history" gap that caused the 141868 stall and the false "silent topic" report, and it uses the existing writer, the existing dedupe and the existing overtaken check.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context, read the code, not this conclusion)
**Independent read of the artifact: concur**

Checked: the recorder runs only after the outcome is decided and cannot change a result or cause a resend; the quiet-recorded and policy-refusal paths record nothing. Local dedupe (`TelegramAdapter.appendToLog`) plus the pooled merge key `out:<messageId>` give one row per delivery. The issues-chat offset matches `ISSUES_TOPIC_OFFSET`; General is not recorded. `policy.text` is the pre-format text the sender would log. The appendToLog handlers are the same ones the existing `recordRecoveredOutbound` call fires. Minor (accepted): the holder row's `sessionName` comes from the holder's own topic→session map, so it can be null or stale for a topic served elsewhere. That affects the label only; overtaken checks read timestamp, direction and provenance.

## Evidence pointers

- `tests/unit/telegram-origin/forwarded-delivery-history.test.ts`: row derivation, chat mapping, a replay of the 141868 sequence (deliver without the holder row, retire with it), and a wiring check.
- `tests/integration/telegram-origin-mesh.test.ts`: a signed mesh submit through the real holder handler records the row; a throwing recorder leaves delivery unchanged; a refused reply records nothing.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller added or changed. Not applicable.
