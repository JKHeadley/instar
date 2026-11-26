# Signed Telegram history scroll boundary

The device history join passes the existing page time to the App store's
indexed read. This prevents a recently recovered App message whose Telegram
log row rotated out from reappearing on an older page.

- Over-block. A store-only row exactly on the boundary is omitted because
  there is no Telegram message ID with which to order it within that instant.
- Under-block. This retains the existing history cursor and page size. It
  cannot distinguish two store-only events at the same cursor timestamp.
- Abstraction. The store applies its own indexed time bound before limiting.
- Signal versus authority. The time bound selects rows after existing route
  authorization. It cannot grant access to a conversation.
- Interactions. Telegram log rows retain their platform-ID tie-break.
- External surfaces. The signed older-page response no longer inserts newer
  recovered rows. Request parameters and current-page behavior stay the same.
- Multi-machine posture. Each signed response applies its local App-store
  join to the requested pool page boundary. Peer transport is unchanged.
- Rollback. Reverting the change requires no data migration.

## 6b. Operator-surface quality

Scrolling back in a Telegram conversation keeps moving into older messages
even when the cloud copy of a recent App message has rotated out.

For a truncated peer page, recovered App rows also respect the pool's
existing oldest-covered timestamp. This preserves the cursor boundary
between the two pages while the peer catches up. The same rows can still
appear when the next page covers them.
