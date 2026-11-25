# Side-effects review for releasing an unstarted managed claim

The only caller releases the work key when it can prove the managed launcher was never called in this invocation. The immediate database transaction retains the old launch identity as retired and frees its work key for a future admission. The retired key prefix is disjoint from valid work keys. An error or rejection after launch was attempted still holds the original claim and requests cancellation.

A pending database row by itself is insufficient proof of an unstarted launch after restart. No background recovery, old-worker retirement, or production launcher is added. The activation switch stays off.

## Second-pass review

**Reviewer:** unstarted_reservation_review, independent Instar second-pass agent

Concur. Before the launcher is invoked its private reservation can be released atomically. Ambiguous launches hold their original claim, and the old launch identity cannot be reactivated.
