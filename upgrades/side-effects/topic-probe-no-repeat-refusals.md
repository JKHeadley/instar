# Side-effects review: topic-name probes stop repeating refused sends

## Change
`TelegramAdapter.resolveUnknownTopicNames` (runs at every start for topics mapped to a session but with no known name) no longer probes General (id 1, which has no creation message to reply to), and does not probe again for 7 days a topic whose last probe Telegram refused (HTTP 400: deleted topic, or not in this chat). Refusals are recorded in `<stateDir>/topic-name-probe-refusals.json`. A transient failure (network) is not recorded, so that topic is tried again next start.

## Evidence
On the Studio (2026-11-02), 190 refused sends in the last week came from probes for topics 1, 659199 and 959198, repeated at every server start ("Could not resolve topic name for …: telegram-400"). The hold error wraps Telegram's reason, so the existing "deleted topic" marking never matched.

## 1. Over-block
A topic refused once and later fixed (re-created with the same id is impossible in Telegram) waits up to 7 days for a probe; its name still arrives from its messages through the lifeline.

## 2. Under-block
None new.

## 3. Level-of-abstraction fit
The resolver loop owns when probes run.

## 4. Signal vs authority
No decision point.

## 5. Interactions
`resolveTopicName` itself is unchanged; only the start-time sweep is filtered.

## 6. External surfaces
Fewer refused Telegram sends and fewer "known-failed" message records.

## 7. Multi-machine posture
Machine-local file, per machine's own probes.

## 8. Rollback cost
Revert; delete the file if desired.

## Class closure
unbounded-self-action: n/a. Reduces an existing start-time probe; adds no action.
