# Side effects: peer stream fold cache and one class review wiring

Change: `ReplicatedPeerStreamReader.materialize` keeps its fold per store and reuses it while every stream file keeps the same path, size, mtime and inode. Both startup paths now wire class reviews through `classReviewRemoteReader`, so a list takes one read. PR 2782 added the one-read path but only to the first of two wiring sites; the second overwrote it at boot, so the fix never ran live.

Measured on a copy of the Studio's live journal and class review database (314 keys): list(20) 9,751 ms and countOpen 8,598 ms before; 29 ms and 22 ms after, with a byte-identical answer. Warm about 20 ms. After a write to the stream, the next read takes 44 ms, so a changed store does not stall for seconds.

1. Over-block: none; nothing is refused.
2. Under-block: a store over 32 MB is not cached and rescans as before. A write that keeps size, mtime and inode identical would be missed; appends always change size and a rewrite changes mtime.
3. Level fit: the rescan lives in `materialize`, so the cache sits there and every per-key caller gains.
4. Signal vs authority: no decision point. The fold, validation and scrub are unchanged; they run less often.
5. Interactions: callers get `structuredClone` copies, so no caller can change the shared fold; before, each got fresh objects, so behaviour is the same. A read that returns no entries from a file is never cached, because `readTailTolerant` answers a failed read that way.
6. External surfaces: none; answers are unchanged.
7. Multi-machine posture: machine-local cache of a read over replicated streams. The streams stay the source of truth, and a peer write lands in a file, which changes the signature.
8. Rollback: revert the commit.
