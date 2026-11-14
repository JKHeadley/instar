# Side effects: class review list reads peers in one scan

Change: `ClassReviewStore.list` asks an optional `all()` on its remote reader, and the production adapter builds that from a new `ReplicatedPeerStreamReader.loadAllOriginRecords`. Previously a list rescanned and revalidated every peer stream once per key. Measured live: `GET /mobile/inside?scope=local` blocked the server about 11 s (a health check stalled 10.8 s; 58% of profile time in scrubSecrets under record validation).

1. Over-block: none; nothing is refused.
2. Under-block: `countOpen` and `list` remain two scans per screen read; the route caches for 15 s.
3. Level fit: the store's list is where the per-key loop lived, so the fix sits there; every list caller gains.
4. Signal vs authority: no decision point. Merge rules are untouched (`mergeWithRemote` is the same code `get` used).
5. Interactions: a reader without `all` keeps the old path. Same merged answer, covered by a test.
6. External surfaces: none; the answer is unchanged, only faster.
7. Multi-machine posture: proxied-on-read, as before.
8. Rollback: revert the commit.
