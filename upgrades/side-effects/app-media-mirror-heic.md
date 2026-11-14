# Side effects: app media Telegram copy (HEIC as document) and Delivered mark in Telegram history

1. Over-block: none. A JPEG/PNG/WebP photo still goes as a photo. Only formats Telegram would refuse change method.
2. Under-block: other refusals (size limits apart from the existing 50 MB line, an unsupported codec inside MP4) still fail the copy, reported with the new wording. The message itself is unaffected.
3. Level: the method choice sits in the Telegram adapter's single file-send path, so every caller gets it. The delivery fact comes from the same store the app-conversation history already reads.
4. Signal vs authority: no decision point; display and transport only.
5. Interactions: `sendMediaGroup` items take the corrected kinds, so a HEIC in a group makes the group documents (existing group rule). The degradation reporter wording changes only for `MobileChat.mirror`.
6. External surfaces: device history rows gain `deliveryState` (an existing field name in app-conversation rows). Telegram sees `sendDocument` instead of `sendPhoto` for HEIC.
7. Multi-machine posture: machine-local by design per request. The delivery state comes from the replicated app conversation store already used by history.
8. Rollback: revert; no state written.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. One copy per operator send, unchanged; no new loop or retry.

## Second-pass review

Not required: transport/display-only change on an existing path.
