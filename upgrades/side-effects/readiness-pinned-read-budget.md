# Side-Effects Review — Pinned readiness quota check: budget parity, one bounded retry, named failure cause

**Version / slug:** `readiness-pinned-read-budget`
**Date:** `2026-11-28`
**Author:** `echo (Subscription Management, Mac M5 Pro)`
**Second-pass reviewer:** a fresh read-only Claude sub-agent (see the section below)

## Summary of the change

`FeedbackTriageAccountSelector.selectPinned` (`src/feedback-factory/triage/FeedbackTriageAccountSelector.ts`) used to cap the whole pinned check at 5 s, with one 4.2 s live read. It swallowed every reader failure into `unreadable`. Now:
- **Budget:** it uses the unpinned selection's 30 s budget, bounded by the caller's deadline. The readiness drain already passes `min(deadline, now + 30 s)`.
- **Retry:** it retries once, only for possibly transient causes (`timeout`, `reader-error`, `no-snapshot`), and never past the deadline minus 700 ms.
- **Cause:** it returns `{ state: 'unreadable', cause, attempts }`. The new `liveTriageReadFailure` classifier names why a snapshot gave no usable percentage.

`readinessAccountAdmission.ts` carries `cause` and `attempts` on the `pinned-account-quota-unreadable` refusal. `FeedbackDrainService.ts` records them in `readinessAccount.last` and in the run diagnosis message.

The unpinned `select()`, the refusal reason names, the 75% saturation rule and the pin are unchanged.

## Decision-point inventory

- Pinned readiness admission (`selectPinned`): **modify**. It gets a larger time budget and one retry; the outcomes are unchanged in kind.
- The refusal record: **modify**. It gains a cause and an attempt count; the reason is unchanged.

---

## 1. Over-block

This change refuses less often. A transient timeout that used to cost a 30-minute pass can now succeed on the larger budget or on the retry. No new refusal exists.

## 2. Under-block

A Codex app-server that is persistently slower than 4.2 s per read still refuses after two attempts, now with cause `timeout`. Raising the per-read cap was deliberately left out, so as not to change the read's own contract. The named cause makes that visible if it happens.

## 3. Level-of-abstraction fit

The fix is in the selector that owns the pinned read, which is where the asymmetric cap lived. It uses the same reader and the same per-read cap as the unpinned path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: this change has no new block/allow surface. It changes a time budget, adds a bounded retry, and records a diagnosis field.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals point. The retry set and the 30 s budget mirror the unpinned path. The cause classifier is an enumerable mapping of snapshot fields.

## 5. Interactions

- **Shadowing:** the drain's admission deadline still bounds the whole check, at `min(deadline, now + 30 s)`. In practice two capped reads take at most about 8.4 s, against 4.9 s before. The readiness call's budget is now recomputed after admission (`FeedbackDrainService.ts`, `remainingAfterAdmission`), so a slower admission can never push the call past the tick deadline. That was already possible before this change, and the change removes it. When no time is left after admission, the tick ends as wall-clock-exhausted.
- **Double-fire:** at most two reads of the same account per admission.
- **Races:** the credential identity is re-read after every attempt, and any change still returns `unverified`.
- **Feedback loops:** none.

## 6. External surfaces

- **Status surface:** `readinessAccount.last` (served in drain status) gains two optional fields on that one refusal. Readers that compare reasons are unaffected.
- **Codex app-server:** at most one more read on a failure. Nothing else is visible outside.
- **Operator surface:** none.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local` by design: the pinned account's Codex home and its live read are on the drain owner's machine (physical-credential-locality). The status is served by that machine, as before.

## 8. Rollback cost

Revert the commit. No state, no migration.

## Conclusion

This is a small, reversible fix for a measured pattern: two refusals at the old cap's timing, with healthy reads of the same account in between. The cause field makes the next refusal provable instead of inferred.

## Second-pass review
**Reviewer:** a fresh read-only Claude sub-agent, given the diff and this artifact and told to audit the artifact against the code (2026-11-28 04:20 PT, uncommitted tree in .worktrees/readiness-pinned-budget).
**Independent read of the artifact:** at first, concern raised (MUST-FIX). `after` was used outside the loop block that declared it, so tsc would have failed. That has been fixed: the success path uses `before`, which every attempt has already confirmed is unchanged. The reviewer confirmed the rest is correct:
- at most two attempts, retried only for transient causes;
- the identity re-check after every read;
- the deadline case reads nothing;
- the union types and their single producer;
- each new test fails on the old code;
- no status consumer breaks.

Minor points, all taken:
- the readiness call budget is now recomputed after admission, so it can never run past the deadline;
- section 5 now gives the real bound of about 8.4 s;
- the `selectPinned` default deadline now uses the 30 s budget constant.
