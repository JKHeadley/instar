# Side-Effects Review — Slack channel titles start with "#", DMs never do

**Version / slug:** `slack-channel-hash`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder, topic 134088)`
**Second-pass reviewer:** `not required`

## Summary of the change

Follow-up to #2974, asked for by Echo after the live re-check of #2966. Rule: "#" for Slack channels (public and private), never for DMs or group DMs, matching how Slack shows them.

- `src/messaging/slack/types.ts`: `SlackChannelKind`; `SlackChannel.is_mpim`.
- `src/messaging/slack/SlackAdapter.ts`: the `conversations.info` lookup that fills the channel-name cache also records the kind (`is_im` → dm, `is_mpim` → group-dm, else channel). A DM skips the name check, because a DM has no name to verify. `cachedChannelKind(id)` answers from that record. A `D` id is a DM before any lookup. Otherwise it returns null and warms the lookup.
- `src/server/mobileSlackRoutes.ts`: `SlackAppConversation.channelKind`; the bridge fills it from the adapter. `slackConversationTitle` shows the label, else the Slack name, else the id, with leading `#` stripped. It puts `#` in front only for a channel. When the kind is not known, a `D` id is a DM and an `mpdm-` name is a group DM.

Tests: `tests/unit/slack-names.test.ts` (title per kind, adapter kind recording), `tests/unit/mobile-slack-from-app.test.ts` (a channel label now shows `#general`), `tests/e2e/mobile-slack-from-app-alive.test.ts` (adapter kind wired through the production bridge).

## Decision-point inventory

No decision-point surface. Display text only.

---

## 1. Over-block

Nothing is blocked. A label that someone set by hand on a channel conversation now also shows with "#". Today the label on a Slack conversation only comes from Slack's channel name at registration, so this is the intended reading.

## 2. Under-block

A legacy private channel that is really a group DM, read before Slack answers and with a name that does not start with `mpdm-`, briefly shows "#". The title corrects itself on the next list read once `conversations.info` answers, within one refresh.

## 3. Level-of-abstraction fit

Right layer. The title function already owned the "#"; the kind comes from the adapter, the one place that talks to Slack, and it reuses the answer the adapter already fetches.

## 4. Signal vs authority compliance

Not a gate. Display only.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- `sessionPresentation.ts` and `resolveChannelTitle` (session titles, registry labels) are unchanged.
- The DM branch skips `verifiedChannelIdentity`. Before, every DM title lookup logged "could not resolve the channel name" once an hour. It no longer does, because a DM has no channel name.

## 6. External surfaces

- **Slack API:** no new calls. The kind comes from the existing `conversations.info` answer.
- **Dashboard and iPhone app:** Slack channel titles gain "#"; DM titles never have one.

## 6b. Operator-surface quality

The title matches what the operator sees in Slack.

## 7. Multi-machine posture

Machine-local by design (physical-credential-locality). The kind cache belongs to the Slack adapter on the machine that holds the Slack connection and its token, the same as the name cache from #2974.

## 8. Rollback cost

Revert the commit. There is no stored state: the kind cache lives in memory.

## Conclusion

Ready to ship. Verified on a throwaway agent connected to the real Slack test workspace: the dashboard list and header show "#dcproof-test" at 1280x728 and 390x844.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable. No self-triggered controller is added. The kind is recorded by the same bounded lookup as the channel name.
