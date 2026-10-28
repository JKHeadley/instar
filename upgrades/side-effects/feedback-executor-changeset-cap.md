# Side-Effects Review — Feedback executor change-set cap

**Version / slug:** `feedback-executor-changeset-cap`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** `/root/review_cap` — concurred with the code boundary; requested the clarification below

## Summary of the change

The feedback executor accepts up to 4 MiB of changed whole-file bytes instead of 2 MiB. It still accepts no more than 200 files and publishes only after the existing sandbox, secret, protected-path, test, and independent review gates. The touched decision is the trusted `buildChangeSet` size refusal. One live attempt failed this refusal after changing a 1.9 MB file and a test; the deleted workspace prevents exact byte attribution.

## Decision-point inventory

- `buildChangeSet` byte cap — modified threshold from 2 to 4 MiB. The 200-file boundary is unchanged.
- Independent review diff cap — passed through unchanged at 192 KiB.
- Secret, special-file, sandbox, and protected-path gates — passed through unchanged.

## 1. Over-block

A legitimate fix that changes more than 4 MiB of whole-file bytes still fails, even if the diff is small. This is an intentional bounded safety limit; the worker may split a large change or a trusted developer can handle it through the ordinary development path.

## 2. Under-block

The new limit admits a whole-file payload between 2 and 4 MiB. It could contain a larger malicious or accidental change, but the file-count, secret, protected-path, and test checks still apply. An actual diff over 192 KiB is refused by the independent reviewer. The separate owner-approval route may still admit such a head after its own gate; this change does not alter that route.

## 3. Level-of-abstraction fit

The byte cap is a hard resource invariant in the trusted executor, not a judgment about code meaning. It belongs before publication. The independent reviewer decides whether the admitted diff is safe.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. This is a hard resource-limit exception to judgment gating. It changes the numeric bound of an existing invariant, and adds no keyword or intent heuristic with independent authority.

## 4b. Judgment-point check

No competing-signals judgment is added. The file byte total is objective; the code-quality decision remains with tests and independent review.

## 5. Integration surface

No new API, config, migration, or persistence. The executor's plain-byte collector and existing review pipeline consume the new constant. A worker that previously failed the cap may now proceed to the same downstream checks; retry policy and daily-start limits are unchanged.

## 6. Operator surface

The feedback dashboard may show fewer `changeset-too-large` failures. No new control, notification, or approval flow is added.

## 7. Multi-machine posture

Machine-local by design: the source checkout and worker workspace live on the drain owner. The constant ships on each installed version. It emits no new notice, holds no new state, and generates no URL.

## 8. Rollback cost

Revert and release. An already-open PR remains subject to the review gate; no stored data migration or agent-state repair is needed. A rollback can make subsequent retries hit the old cap again.

## Conclusion

The enlarged byte bound matches the current source-file size while preserving the separate review-size bound. It should be verified with a new live executor attempt after installation. The exact bytes of the failed attempt remain unavailable because its workspace was cleaned up.

## Second-pass review

The independent reviewer concurred that the byte cap is a resource boundary and the existing downstream authorities remain separate. The reviewer identified the need to distinguish independent-review refusal from the owner-approval route; §2 and the release note now state that distinction explicitly.
