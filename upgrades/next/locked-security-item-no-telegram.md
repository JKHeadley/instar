## What Changed

- An agent with no Telegram now has an attention list. Before, the remote-desktop security items ("A Mac may still be unlocked", "Remote desktop through the lock was turned off") had nowhere to go without Telegram: the server printed a warning and the owner was never told. They are now stored on disk (`state/local-attention-items.json`, one row per condition, bounded to 200 rows, open rows never dropped) and pushed to paired phones.
- `GET /attention`, `GET /attention/:id` and `PATCH /attention/:id` serve that local list when there is no Telegram (the list carries `surface: "local"`) instead of answering 503. The iPhone app's notification lookup reads it too. With Telegram, nothing changes.
- The relock record is only marked "reported" after the item is actually stored, so a failed write is retried by the next sweep.
- CLAUDE.md (new and existing agents): one bullet saying an agent without Telegram still has an attention list and where to read it.

## What to Tell Your User

If you run me without Telegram and I ever can't confirm that a Mac relocked after a remote-desktop session, you'll now see it: it shows up in my attention list, in the Instar app, and as a phone notification. Before, that warning had nowhere to go.

## Evidence

- Unit: the store keeps one row per id, reopens on a re-raise, reports false when it cannot write, stays bounded without dropping open rows, and survives a corrupt file.
- Integration: the three attention routes serve, filter and resolve the local list without Telegram, and still answer 503 with neither Telegram nor a local list.
- E2E (production boot, no Telegram, remote desktop off so no real Mac helper starts): `GET /attention` answers 200, and the same method the locked-screen controller calls puts the security item on it.

## Summary of New Capabilities

- Attention list without Telegram: `GET /attention` / `PATCH /attention/:id` work on an agent with no Telegram, holding security items such as "A Mac may still be unlocked".
