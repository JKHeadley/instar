# App conversation sync cursor scope

- Over-block. Previously issued unscoped cursors replay history once. Clients
  already deduplicate by event identity when a machine changes.
- Under-block. The cursor is an offset hint. This does not add a storage
  generation or alter access checks.
- Abstraction. The App event store validates the cursor against the canonical
  key used in its indexed query.
- Signal versus authority. Scope controls pagination after access is granted.
  The cursor grants no visibility.
- Interactions. Same-chat cursors resume as before. Invalid, legacy and
  mismatched cursors return a scoped cursor after replay.
- External surfaces. The cursor remains opaque and the route is unchanged.
- Multi-machine posture. A cursor from another machine still restarts from
  the beginning. This requires no shared state.
- Rollback. No data migration is needed.

## 6b. Operator-surface quality

The client still receives the existing event and cursor fields. The
server avoids skipping messages when clients change conversations.
