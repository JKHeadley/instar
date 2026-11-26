# Store-backed App Delete journal revision

The private sync authority uses the current App store journal revision by default. A trusted indexed append preserves the revision and advances the underlying frontier. A replacement or rebuild starts a new revision. An unindexed file cannot issue one. The store detects and rolls back a short journal write before indexing it.

The production server creates the same store. The lifecycle fixture exercises the real revision while Delete remains off. Production route and live native verification are pending.

## 6b. Operator-surface quality

New messages keep sync moving. An unexpected journal change makes the app reconcile rather than trust an old position.

## Framework generality

The revision is independent of the paired device platform and agent harness.
