# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When feedback readiness is pinned to one Codex account, its live quota check now gets the same time budget as the unpinned selection: up to 30 seconds, bounded by the readiness deadline. Before, it had 5. It also retries once when a read fails in a way that may be temporary (a timeout, a reader error, no snapshot). A refusal of the pinned account now says why the quota could not be read. The cause is one of `timeout`, `reader-error`, `no-snapshot`, `deadline`, `wrong-source`, `windows-unavailable`, `rate-limit-reached`, `stale-capture`, `no-windows` or `invalid-window`, and is recorded with the attempt count in the readiness status and diagnosis. The readiness call that follows now gets only the time actually left after this check, so it can never run past the pass's deadline. The refusal reason itself (`pinned-account-quota-unreadable`), the pin and the 75% rule are unchanged.

## What to Tell Your User

Feedback readiness pinned to one account no longer loses a whole half-hour pass because one quota check was slow. When it does refuse, it now says exactly why.

## Summary of New Capabilities

- `readinessAccount.last` gains `cause` and `attempts` on a `pinned-account-quota-unreadable` refusal.

## Evidence

On 2026-11-28, the Studio refused the pinned account codex-amrch twice (22:32 and 04:04 PT). The refusals came 6.70 s and 4.36 s after clustering ended, which matches the old 5 s cap and 4.2 s read. Between them the same account read fine, and the Studio's poller reads all five Codex accounts in about 10 s. tests/unit/feedback-factory/readiness-account-admission.test.ts covers:
- the cause and the two attempts;
- recovery on the retry;
- a slow read classed as a timeout, with the retry kept inside the deadline;
- the deadline case reading nothing;
- non-transient failures that are not retried.
