# Side-Effects Review — Slack thread history names each message's own sender

**Version / slug:** `slack-history-sender-label`
**Date:** `2026-11-04`
**Author:** `Echo`
**Tier:** 1 (label fix in injected context; a revert fully undoes it). Size: 1 new 20-line module, 1 changed line in server.ts, 6 tests.

## Summary of the change

When a Slack message spawns or resumes a session, the server injects the recent thread history. Every non-bot line was labelled with the CURRENT message's sender name (`senderName || m.user`), so in a shared thread person A's message read as person B's. Found on the B2Lead proof (topic 136880, 2026-11-04): Echo (U0CER2ZL62Y) wrote "I'm Echo and my favourite colour is blue"; when Dawn (U0CFJ95JMFS) replied in the thread, the history showed both lines as U0CFJ95JMFS, and the agent said "Both messages appear under the same Slack user ID". The raw inbound log had the right IDs; only the injected history was wrong. Now each line gets its own sender: the bot is "Agent", the current sender's own lines keep their display name (one-person conversations read exactly as before), everyone else is shown by their own user ID. The recovery path already used `m.user` and is unchanged.

## Decision-point inventory

None — this changes what text the agent reads, not what is allowed.

## 1. Over-block
None.
## 2. Under-block
Other people appear as raw user IDs rather than names (as in the recovery path). Correct and distinguishable; resolving names is a separate improvement.
## 3. Level-of-abstraction fit
The label rule moves into a pure helper next to the Slack adapter; server.ts calls it.
## 4. Signal vs authority compliance
No authority involved (context text only). Authorization stays on the real sender ID in the adapter.
## 5. Interactions
The per-message `[slack:… from … (uid:…)]` prefix is unchanged and already correct.
## 6. External surfaces
The helper carries a CONTRACT-EVIDENCE: EXEMPT marker: it calls no Slack API method and reads no new field.
The injected context text for multi-person Slack threads changes; single-person conversations are byte-identical except where a line had no user (now "unknown" instead of the sender's name).
## 7. Multi-machine posture
Machine-local by design (per-spawn context text); nothing stored.
## 8. Rollback cost
Revert the commit.

## Evidence
- Unit: tests/unit/slack-thread-history-label.test.ts (6 cases incl. the shared-thread case and a three-person thread).
- Live: nimbus /tmp/instar-slack/ctx-C0CER2ZV38U-1793764348319.txt showed both lines as U0CFJ95JMFS; slack-messages.jsonl had U0CER2ZL62Y and U0CFJ95JMFS.
