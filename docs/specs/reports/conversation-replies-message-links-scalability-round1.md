# Scalability Review — Round One

Scope: quoted replies and exact message links only. Read-only source/spec review; no tests run. Reviewer is the inherited Codex agent; exact runtime model is not exposed.

## DESIGN — Exact Lookup Must Not Inherit History-Window Absence

The signed-send contract resolves an original through the bounded history/pin reader and maps unknown/absent/forbidden to 404. A message outside that reader's recent window is not proved absent. This can prevent replying to, or copying a link to, an older message whose exact ID the client already possesses. Increasing the history bound would increase request cost without fixing the decision boundary.

Actual source already has an indexed native App seam: `AppConversationStore.getMessageEvent(conversationKey, messageId)` looks up the message index and reads the event using the destination conversation. Prefer that exact-ID seam and apply current message authorization to its result. Provider histories need an explicit distinction between a proved miss and an unavailable exact witness; reuse existing holder evidence and report uncertainty rather than asserting a bounded-window miss proves absence. No exhaustive history scan or additional locator subsystem is needed. This agrees with the first round-one conformance finding.

## PRECISION — Make Request-Local Source Reuse Mandatory For Provider Projection

The spec currently says to use one bounded request-local source view “where possible.” In actual source, `mobileSlackRoutes` bridge `history()` folds its tail, merges the adapter ring, and sorts before slicing. Calling that reader separately for each quoted row would repeat the same fold/sort for every quote, producing multiplicative request work.

State explicitly that each platform/conversation source view is loaded once per response and indexed by exact message ID, with duplicate quote references memoized within that response. App originals can use distinct exact indexed reads. Keep authorization per current viewer and recheck after awaits; do not share rendered quote DTOs across readers. Existing App and Slack response paths already use `Cache-Control: no-store`; retain that behavior on the new read/projection paths unless a cache explicitly includes current authorization and source versions. This is clarification of the intended request-local design, not a new cache subsystem.

## Other Reviewed Areas

The draft correctly avoids recursive alternative-witness searches, new timers, background scans, additional stores, and provider-routing changes. Dynamic projection across pool, sync, pins, previews and notifications is appropriately scoped to the current reader; peer quote previews are not authority. Keep ordinary response paging bounded independently of exact-original lookup. No additional material performance findings.
