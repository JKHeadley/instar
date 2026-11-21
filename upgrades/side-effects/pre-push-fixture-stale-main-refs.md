# Side-Effects Review — pre-push fixture guard main refs

**Version / slug:** `pre-push-fixture-stale-main-refs`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** independent Codex reviewer

## Summary of the change

`scripts/pre-push-fixture-guard.mjs` now excludes commits reachable from any available local `upstream/main` or `origin/main` ref, as well as the branch's tracking ref. Previously it selected the first available main ref, so a stale `upstream/main` could classify a fixture-authored commit already on `origin/main` as new branch pollution. The guard's recovery text now asks developers to fetch main refs before changing history. `tests/unit/scripts/pre-push-fixture-guard.test.ts` covers the reported case, a true branch-only fixture, a configured upstream, and diverged main refs.

## Decision-point inventory

- Pre-push fixture guard's commit selection — modified — the commit range excludes the union of available base refs.
- Pre-push fixture signature check — passed through — existing author and subject patterns still decide whether a remaining commit blocks the push.
- Missing-base and Git-error paths — passed through — the guard still exits successfully when it cannot establish a range.

## 1. Over-block

A commit that was already on remote main can still be classified as new if every local remote-tracking main ref is stale. The hook intentionally does not fetch during a push. The recovery text directs the developer to refresh refs before changing branch history.

## 2. Under-block

A fixture commit reachable from any local main ref is excluded even if that ref was later force-pushed away on the server. If `upstream/main` and `origin/main` diverge, a fixture commit only on the upstream side is also excluded when that commit appears on the branch being pushed to origin. This under-block already existed for the no-tracking fallback that selected upstream first, but the union also applies it to branches with a different tracking ref. The guard relies on local refs and signature patterns, so it can miss pollution with a different author and subject. The existing repository invariant check remains a separate backstop.

## 3. Level-of-abstraction fit

The change stays in the existing lightweight pre-push hook. Git reachability is the correct primitive for deciding whether a commit is already on a known base. Fetching or consulting GitHub from the hook would add network timing and availability to every push.

## 4. Signal vs authority compliance

The existing guard has blocking authority based on narrow fixture signatures. This change adds no new signature or block category; it narrows the set of commits fed to that existing decision. The original approved [test-environment isolation spec](../../docs/specs/test-env-isolation.md) treats this as a safety backstop before repository contamination can be pushed, while the primary protection is environment sanitization. The guard is not a general judgment about a developer's intent.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Whether a commit is reachable from a local ref is a Git graph fact.

## 5. Interactions

- **Shadowing:** The hook still runs before smoke tests; this change does not alter hook ordering or the separate repository invariant check.
- **Double-fire:** No new action is added; the guard still returns one pass or refusal per invocation.
- **Races:** Remote-tracking refs can change during a push, though each `git log` reads a coherent set of object IDs. A later fetch can change the next invocation's result.
- **Feedback loops:** No persistent feedback state is written.

## 6. External surfaces

Developers see fewer false push refusals and a revised recovery message. The hook reads only local Git refs and makes no external request. No new operator-facing action or dashboard surface is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Each checkout has its own remote-tracking refs; the same code runs on each machine and compares that machine's local refs. No durable user state, URL, or cross-machine notification is involved.

## 8. Rollback cost

Revert the script and test changes in a patch release. There is no state migration or repair. Reverting would restore the reported false block on stale checkouts.

## Conclusion

The change removes the reproduced false block while retaining branch-only fixture detection. The remaining local-ref staleness is explicit in the recovery message and does not require a new network dependency in the hook. Ready for review after the independent second pass.

## Second-pass review

**Reviewer:** independent Codex reviewer
**Independent read of the artifact:** concur with the range fix; no code blocker found. The reviewer identified the divergent-ref under-block above and stale comments in the tests, which were corrected before this artifact was finalized.
