# Quota snapshot hardening

## 1. Behavioral change

- Malformed Claude credential JSON now moves the matching subscription account
  to `needs-reauth`.
- Per-account quota reads now include `staleSnapshot` and `snapshotAgeMs`.

## 2. Compatibility

The response is additive. Existing consumers of `snapshot` and `burnRate`
continue to work. The existing nullable token-resolver contract remains valid;
injected resolvers may additionally return the typed re-auth result.

## 3. Operational impact

Quota snapshots become stale after 30 minutes, which is twice the default
15-minute poll cadence. This does not delete a snapshot or prevent it from being
displayed; it makes its age visible to consumers.

## 4. Security

Malformed credential contents never leave the credential reader. Logs and pool
state receive only the closed reason `unparseable-credential-blob`.

## 5. Rollback

Reverting this change restores the previous silent-null resolver behavior and
removes the additive freshness fields.

## 6. Validation

Unit coverage exercises detailed parsing and the re-auth transition. Integration
coverage exercises fresh, old, and invalid `measuredAt` values through the HTTP
route.

## 6b. Operator-surface quality

The read surface distinguishes three states directly: no snapshot, a current
snapshot, and a stale snapshot. Operators no longer have to infer freshness by
manually comparing timestamps.

## Class closure

This is a bounded read-path classification fix. It does not introduce a timer,
retry loop, autonomous controller, or self-action emitter.
