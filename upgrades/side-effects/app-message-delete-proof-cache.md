# App Delete local history proof cache

This checkpoint changes the unmounted, custody-aware store projection. It retains up to 64 successful history proofs ordered by recent use. Journal checkpoint and SQLite write generation still govern every hit. Index rebuild clears the cache. Removal receipt lookups retain their separate proof.

The cache makes no changes to permissions, journal bytes, replication, runtime routes or client capabilities. Reverting this checkpoint restores the single history-proof slot. The cold scan remains synchronous and must be bounded or moved before interactive use.

## 6b. Operator-surface quality

A recent history check can be reused after opening another chat on an unchanged store. A subsequent removal forces a fresh proof and hides the exact removed occurrence.

## Framework generality

The store behavior is independent of the client and agent harness.
