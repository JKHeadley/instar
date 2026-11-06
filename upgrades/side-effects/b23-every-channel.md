# Side-Effects Review — B23 on every channel, and reaction flags in every reply script

**Slug:** b23-every-channel
**Tier:** 1. Size: 15 code and test files. Effort: no new spec (the converged spec already says B23 reaches every channel); second pass below.

## Summary of the change

`evaluateOutbound` read recent turns only for a Telegram `topicId`, so `conversationContext` was false on every other channel and B23's crediting half never fired. New option `attributionConversation`, passed by the Slack, app, WhatsApp and iMessage routes. Under attribution `enforce` only, `ChannelReaders.recentConversation` reads the last 256KB of that channel's log, or the app store, and supplies `recentMessages`. The background send record uses it too, for the recap exemption, whenever attribution is on, including `record`: after delivery, it reads the same tail and passes recent turns to the judge and ledger, so record-mode data on these channels is accurate. `/slack/session-reply` now accepts `metadata` holding only the four tone fields and refuses anything else with a 400, so a spawned session can answer an advisory and reaches nothing more. The four reply scripts gain the tone flags and print the advisory. `imessage-reply.sh` replaces `head -n -1`. Migrations: prior SHAs for Slack and app, feature markers for WhatsApp and iMessage.

## Decision-point inventory

- B23 inside the tone gate (the existing authority): reaches more channels. No new authority. Advisory, and a reasoned ack always delivers.

## 1. Over-block

B23 can now hold on four more channels, only under `enforce`, and it is advisory. iMessage: outbound rows use the normalised recipient and inbound rows use `chatId`, so the conversation can look one-sided. A recap of the user's words may then read as a credit and be nudged. WhatsApp assumes the JID matches the logged `channelId`. Answerable with an ack either way.

## 2. Under-block

The 256KB tail can miss an older turn in a busy log, which leaves `conversationContext` false for a quiet conversation in a busy file: B23 stays unmeasured there, as it was. Slack thread rows are not separated from channel rows, so the turns may come from another thread in the channel; that can only excuse a recap. Sends that do not use these routes are not covered. Bare-curl sends with no metadata still get a 422.

## 3. Level-of-abstraction fit

`ChannelReaders` already owns each channel's log location. The route passes only an id. One helper, not four.

## 4. Signal vs authority compliance

Complies. The new data is a signal to the tone gate, the single authority. No brittle check gains blocking power.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic added. The judgment stays with the tone gate.

## 5. Interactions

`recentOutbound` stays Telegram-only, so the dedup gate does not change on any channel. Under `enforce` the tone review on these channels sees recent turns for every rule, not only B23. A synchronous read of at most 256KB runs before the send only under `enforce`, and after delivery whenever attribution is on. `--native-reference` and the Slack channel argument still parse after the new flags, which come first.

## 6. External surfaces

Script output on a 422 advisory changes. New flags on four scripts. A misplaced flag after the channel id on Slack still reads as message text, unlike Telegram, which refuses it. Dark agents see no server change. Agents on `record` see no change to the tone review or to delivery; only their background send record gains recent turns, which also raises what it sends the judge.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard or approval page touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: recent turns come from this machine's log, which is the machine sending. A conversation that moved machines may show fewer turns; B23 then stays unmeasured or nudges, and both are safe.

## 8. Rollback cost

Plain revert. Agents that took the new scripts keep sending normally on an old server. Only a Slack session's tone reaction gets a 400 there, because that route did not accept `metadata`; the other channels' routes already did.

## Conclusion

Clear to ship. The spec's every-channel promise did not hold.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, three reads
**Independent read of the artifact: concur**

The first read found that `/slack/session-reply` refused the new metadata, so spawned Slack sessions could not answer an advisory, and that the send record reads turns in `record` too. The second found an existing route test the first fix contradicted, a false rollback claim and a stale size. The route now refuses all metadata except the four tone fields, and the claims are corrected. The third read concurs. Its checks: prior SHAs match origin/main, markers occur exactly, the body-suffix edit is correct, a missing python3 does not break a send, and conversation ids match, with the iMessage mismatch disclosed. It ran no integration tests; my run passed 27 of 27 across both changed integration files.

## Evidence pointers

- Live test: `.instar/lanes/attribution-live-rung-1106/REPORT.md` (Echo's home) and the ledger lines for the slot.
- `tests/unit/reply-scripts-tone-reaction.test.ts`, `tests/unit/attribution/channelReaders.test.ts`, `tests/integration/attribution-routes.test.ts`.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `instrument-semantic-darkness`: the check ran and reported on every channel, but off Telegram its inputs prevented the verdict from ever changing.
- **`closure`** — gap: ACT-605. A class guard here is a live replay across channels.
