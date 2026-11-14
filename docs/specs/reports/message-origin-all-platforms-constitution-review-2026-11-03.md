# Review: message origin article extended to every platform (2026-11-03)

## What changed
`docs/STANDARDS-REGISTRY.md`, article *Telegram Message Origin Is Mandatory; Its Display Is Optional*: the Rule now covers every platform (Telegram, Slack, app conversations, future platforms); the ratification line cites Justin's 12:10 request and 17:25 "Yes" in topic 134088; Derives-from and Applied-through name Slack and app conversations and record WhatsApp/iMessage (ACT-023) as a conformance gap, not an exemption. The bounded exception paragraph in *The User Experience Is the Product* now says "outgoing origin recording" instead of "outgoing Telegram recording".

## What I checked
1. Authority: scope matches the request ("recorded with every message sent to the user for any platform"). Display stays default-on and hideable, as before; no new authority is claimed. Title kept, with the reason stated.
2. Consistency: the Fails clause (hold when recording cannot be established) now covers Slack. `SlackOriginLedger.ts` throws `SlackOriginRecordingError` when the intent row cannot be written (fail-closed), and the spec's pre-recorded per-conversation notice matches "separately recorded notice". App replies carry `agentOrigin` on the same event record (`AppConversationStore.ts`), so reply and origin are one write. The exception paragraph's scope stays bounded to recording/custody outages.
3. Paths: every cited source, test, spec and report file exists.
4. Wording: plain and accurate.

## Findings
- F1 (minor, not blocking): the Slack sentence omits the spec's operator-set exception `messageOrigin.recording.slackFailClosed: false`. The Fails clause has no such exception, so a reader could think none exists. Suggested replacement: "...`src/messaging/slack/SlackOriginLedger.ts` (a Slack send is held when its origin row cannot be written, unless a verified operator has set the live exception `messageOrigin.recording.slackFailClosed: false`)". Resolved: applied verbatim before recording.
- F2 (note): the spec's graduation line says the wording change goes to Justin after a week on the development agent; his 17:25 "Yes" already approved it, so this is not a conflict. Resolved.

Verdict: accepted
