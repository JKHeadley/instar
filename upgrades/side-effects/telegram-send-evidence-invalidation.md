# Invalidate edited Telegram send evidence

The dormant store can permanently invalidate a canonical message reference. An edit received before the original creates an invalidated row so later capture cannot make the original usable. An edit after capture keeps the original digest and disqualifies its use.

- Authority. The caller must authenticate the update and resolve the original coordinates before calling this method. This checkpoint leaves production polling unchanged.
- Ordering. The invalidation is a committed SQL write. It stops subsequent reservations; it cannot undo an attempt reserved first.
- Data. An edit seen first records only the source reference and an invalidation marker. No edited content is stored.
- Rollback. The checkpoint adds no installed schema, configuration or live caller.

Independent review concurred on the dormant upsert and both arrival orders.
