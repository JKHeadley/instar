# Machine signing evidence for private Delete sync

The private observer captures signing history and a revision together. It verifies file descriptors and paths, refuses an outstanding identity transaction, and rejects malformed epoch data or signing cutoffs. It retains up to 64 scopes and does not serve decisions from the existing timed lookup cache.

The registry file contributes an invalidation checkpoint. IdentityStore still supplies signing histories. The observer does not grant membership and production does not consume it yet. Construct it at boot so existing transaction recovery stays in its established lifecycle.

## 6b. Operator-surface quality

A change to signing evidence can force a sync refresh while preserving the use of legitimately retired keys for older signed messages.

## Framework generality

The signing revision is independent of the device client and agent harness.
