# Side-Effects Review — Local Verify re-posts its GitHub status when the reason changes

**Version / slug:** `lv-status-reason-repost`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: harness-changing — src/localVerify/**)`

## Summary of the change

Tier 1, 2 files. `StatusReconciler` posts the `instar/local-verify` commit status that gates merges. It (re)posted only when the projected **state** (pending / success / failure) differed from the state it saw, so a change of **reason** under an unchanged state never reached GitHub. On PR #2405 (2026-10-27) the status read "verifying" for about 40 minutes, twice, while the true projection was `pending · awaiting-independent-review` — a correctly held PR that looked like a hung verifier, which cost a misdiagnosis and a wrong bug report.

Now the reconciler remembers the description it last posted on each head (`selfPostedDescription`) and a new `needsPost(head, desired, seen)` is true when the state differs **or** the state matches but the description it last posted differs from the projected one. It replaces the three state-only comparisons (the two pass-loop decisions and the guard at the top of `send()`). The `withdraw` flag, which lets a post bypass the per-minute cap, is now set only when the state actually leaves success, so a description-only refresh never jumps the cap.

What it does not change: which state is projected, so no PR passes, fails or merges differently; lease/epoch gating; the dry-run (`would-post`) path, which already keyed on state and description. After a server restart the map is empty, so the first refresh happens on the next real change — the same as today.

Evidence: new unit test reproduces the #2405 sequence (post "verifying"; the run ends with a harness-changing record lacking an independent review) and expects a second post whose description starts with `awaiting-independent-review`, then no further posts. It fails on origin/main (1 failed / 42 passed) and passes with the change (43/43).

Coordinated: topic 130715 (Increasing Throughput, owner of Local Verify scheduling) told before the PR.

## Decision-point inventory

`instar/local-verify status post` — modify — when to post (adds reason-change), not what to post.

## 1. Over-block
No new pending/failure. The projection is unchanged.

## 2. Under-block
None: no change to what can reach success.

## 3. Level-of-abstraction fit
The reconciler owns posting; the projection stays the single authority on state and reason.

## 4. Signal vs authority compliance
The status is the floor's authority; this only makes its displayed reason current (`docs/signal-vs-authority.md` reviewed).

## 5. Interactions
Extra posts are bounded: one per actual description change per head, under the existing per-minute cap and retry backoff.

## 6. External surfaces
GitHub commit status descriptions are more accurate.

## 7. Multi-machine posture
Runs only on the serving-lease holder (unchanged); the map is in-memory per holder and empties on a lease move, like the existing `selfPosted` map.

## 8. Rollback cost
Revert.

## Second-pass review

**Reviewer:** independent subagent (verdict delivered in its report; recorded here by the author)
**Verdict:** Concur with the review

- Every projected description is a pure function of its inputs (record timestamps, flags, lane counts, main health, problem counts) — no clock or counter — so an unchanged input never re-posts; a successful post records the description, and a third pass posts nothing (the test checks it).
- Dry-run never fills the new map and `would-post` is still deduped by state+description; a failed post leaves the map unchanged and the retry stays on the existing backoff.
- Same-state reason refreshes count against the 30/minute cap; `send()` decides withdrawal independently and unchanged; the pass-loop `withdraw` change produces identical results for every existing success→non-success case.
- Restart: an empty map falls back to the old state-only check — no regression.
- The new test fails on origin/main's reconciler and passes with the change; `tests/unit/localVerify/` 22 files, 556 passed.
- Noted, harmless: on a head shared by several PRs the description follows the first PR in listing order (stable in practice, bounded by the cap); the map, like `selfPosted`, is never pruned (one short string per head).
