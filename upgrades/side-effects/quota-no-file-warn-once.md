# Side-Effects Review — QuotaTracker one-shot missing-file warning

**Version / slug:** `quota-no-file-warn-once`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

A `warnedNoFile` boolean is added to `QuotaTracker`. The missing-file branch warns only when the flag
is unset (then sets it); the file-present branch clears it. Net effect: one warning per absence episode
instead of one per `getState()` call. No change to the value `getState()` returns.

## Decision-point inventory

None. `getState()` still returns `null` when the file is absent or stale (fail-open). The flag only
gates a `console.warn` side-effect — it never affects the return value or any gating decision.

## 1. Could a real warning be SUPPRESSED?

Only repeats of the *same* condition are suppressed; the first occurrence of each absence episode still
logs. The flag re-arms when the file reappears, so a file that later disappears warns again — the
operator never loses the *signal*, only the *spam*. The stale-data and remote-API warnings are
untouched.

## 2. Could the flag get STUCK (never warn again when it should)?

No. The clear happens on the file-present path (right after `existsSync` passes, before the read), so
any successful observation of the file re-arms the one-shot. A persistently-missing file warns exactly
once — which is the intent.

## 3. Concurrency / state

`QuotaTracker` is a per-process singleton with synchronous `getState()`; the flag is plain instance
state mutated only inside that method. No async interleaving, no shared-file contention introduced.

## 4. Reversibility

Pure in-memory flag, no migration, no persisted state, no config. Revert = revert the two edits.

## Verdict

Bounded, additive, no decision-surface change. Removes a high-volume log-spam (902×/day observed)
without altering quota behavior.
