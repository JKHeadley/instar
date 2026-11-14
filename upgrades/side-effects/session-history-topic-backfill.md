# Side-effects review: session History reaches back through the conversation's earlier sessions

## Change
1. `TelegramAdapter.getTopicHistoryBefore(topicId, beforeMs, limit)`: up to `limit` log entries for the topic strictly before `beforeMs`, oldest first. It reads the message log backwards in 1 MB chunks and stops once the page is full (the Studio's log is 142 MB; the existing `scanLogForTopic` reads it whole). A partial line at a chunk edge is carried as bytes, so a multi-byte character split across chunks survives (tested).
2. `GET /telegram/topics/:id/messages` accepts `before` (ISO time or epoch ms; anything else is a 400). With `scope=pool` the cursor is forwarded to each machine. Without `before` nothing changes.
3. Console History: when a session's own transcript reaches its start and the session is a Telegram topic, History continues with that topic's messages before the transcript's oldest entry, 50 at a time, under the divider "Earlier, from this conversation's previous sessions". Only messages strictly older than the cursor are shown, so a server without `before` support (it returns the newest messages) ends the section instead of repeating messages.

## Evidence
Topic 127504's first message is from 2026-10-20; History in the console stopped at 2026-10-31, where the current session's transcript begins.

## 1. Over-block
None. A malformed `before` is refused with 400 rather than silently ignored.

## 2. Under-block
History reaches back as far as the message log goes; log rotation bounds it. A machine on an older version ignores `before` and contributes nothing older (its rows are filtered out), so a pooled read may show fewer earlier messages until every machine is updated.

## 3. Level-of-abstraction fit
The adapter owns the message log; the route already serves topic history; the console already pages History. Correct layers.

## 4. Signal vs authority
No decision point. Read-only.

## 5. Interactions
The tail cache and `getTopicHistory` are untouched. Each scroll-back page is a synchronous read of only as many 1 MB chunks as needed; for a page far in the past it can read a large part of the log, once per scroll page (the operator scrolling), never on a timer.

## 6. External surfaces
A new optional query parameter on an existing authenticated route.

## 6b. Operator-surface quality
Checked on the preview at 390×844 against the current server (no `before` support yet): History switches to the earlier-messages phase, finds nothing strictly older, and ends with "The start of this conversation." with no repeated rows and no sideways scroll. The full reach-back needs the server half installed; it is covered by the integration test.

## 7. Multi-machine posture
Pooled reads forward the cursor; each machine reads its own log. Machines on older versions degrade to contributing no earlier rows.

## 8. Rollback cost
Revert the commit; no data.

## Follow-up
The malformed-line catch in `getTopicHistoryBefore` carries a `@silent-fallback-ok` reason (the no-silent-fallbacks ratchet counted it as new).
