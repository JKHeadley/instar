# Side-effects review: a merge pass moves past PRs it cannot act on

## Change
`src/monitoring/GreenPrAutoMerger.ts` (tick): instead of acting only on the single oldest eligible PR, the pass walks eligible PRs oldest first. When `act` returns `episode-not-eligible` (the PR's episode gave up or is backing off) or `gave-up-rearm-exhausted`, it logs `skipped:episode` and gives the next-oldest PR its turn. Any other outcome (a merge attempt, a refusal from safe-merge, identity/contract/busy skips that apply to every PR) ends the pass as before, so a pass still makes at most one merge attempt.

## Evidence
On the Studio (2026-11-02) the eligible snapshot at 20:41 was 2378, 2381, 2567, 2596 (2374 already armed). #2378 has been in `gave-up` since Oct 26 (refused:body-checks), so that pass picked it, `act` returned `episode-not-eligible` without a log line, and the pass ended. #2596 passed its local verify at 20:10, missed its one-shot hand-off because GitHub was still recomputing mergeability, and merged only at 20:46: about 36 minutes later, on a pass where #2378 happened to read as not mergeable. The stall is intermittent (it bites whenever a gave-up PR reads mergeable), not permanent; every green PR that misses its hand-off waits behind it for as long as that lasts.

## 1. Over-block
None; this unblocks.

## 2. Under-block
A PR in `gave-up` is still never merged automatically (unchanged): it is only no longer allowed to stop the others.

## 3. Level-of-abstraction fit
The tick's selection loop, where the head-of-line choice is made. Episode rules themselves (`episodeEligible`, `maybeRearm`) are unchanged.

## 4. Signal vs authority
The watcher keeps the same authority (safe-merge is still the act-time gate). Only the order of consideration changes.

## 5. Interactions
At most one `runner.run` per tick (tested). Dry-run still reports the oldest. The loop is bounded by the eligible list (a handful of PRs). Every PR skipped this way now leaves an audit line, so a long-stuck PR is visible.

One behaviour change to note: before, the oldest PR's backoff paced the whole queue. Now, during a fault on this machine's side (repeated runner errors), each tick tries the next PR, so more PRs can step through their retry ladders; it is still one attempt per tick and the circuit breaker still stops all attempts. Each tick also writes one `skipped:episode` audit row per gave-up PR still open, so the audit log grows with the number of stuck PRs (each row names one, which is the point).

## 6. External surfaces
More of the agent's own green PRs merge. No operator-facing text.

## 7. Multi-machine posture
Runs on the lease holder only, as before.

## 8. Rollback cost
Revert the commit.

## Class closure
unbounded-self-action: n/a. A bounded scan over the current eligible list within one tick, still at most one merge attempt per tick; no new loop or trigger.

## Second-pass review
**Reviewer:** independent Claude Opus 5.5 subagent (general-purpose), given the diff and the write-up, not the conclusion.

Concur with the review. Both pass-on returns come before `probeContract`, `refetchPr`, `inFlight`, `runner.run` and `recordOutcome`; the only work before them is the TTL-cached identity check and `maybeRearm`. At most one attempt per tick holds (every post-spawn outcome is outside the pass-on set). `episodeEligible` is false only for gave-up or an unexpired backoff; breaker, identity, contract and busy skips still end the tick. Hand-off and dry-run unchanged. Suggested tests added (backoff pass-on); the runner-fault pacing note above is from this review.
