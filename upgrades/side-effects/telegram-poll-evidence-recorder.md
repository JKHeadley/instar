# Telegram polling evidence recorder

The dormant helper records eligible original messages and applies edit invalidation before returning. Missing edit coordinates or a refused write throws, so callers can leave the update unacknowledged.

- Authority. Only an authenticated direct poller may supply the bot, current owner and raw update. The helper has no production caller and cannot change polling or send behavior.
- Ordering. The caller must stop the batch on error and close evidence coverage before another reservation. Cursor management stays in the poller.
- Data. The helper uses the existing digest-only store. Edits can invalidate evidence even when their text no longer qualifies as a direct request.
- Rollback. No live state or installed schema changes.

Independent review concurred. Before live use, validate the authenticated single-update shape and keep the reservation gate closed throughout catch-up.
