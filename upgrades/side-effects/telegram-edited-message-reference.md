# Locate the original Telegram request on edit

This dormant helper derives the same canonical evidence reference as direct polling capture, using authenticated edit coordinates. It does not parse the edited text.

- Authority. Callers must already have authenticated the edited-message update and its bot account. This helper only selects an invalidation reference and cannot grant approval.
- Refusal. Missing raw coordinates return no reference. A future poller must close evidence coverage if an edit cannot be safely mapped.
- Data. Only a coordinate reference is returned. Edited text and media never leave the update.
- Rollback. There is no live polling caller or migration.

Independent review concurred on the shared coordinate format and the dormant revocation boundary.
