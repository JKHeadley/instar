# Side-Effects Review — SafeFsExecutor recursive-delete retry defaults

**Version / slug:** `safefs-rm-retry-default`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

New private `withRmRetryDefaults`: when a safeRm/safeRmSync call is `recursive && force` and the caller did NOT set `maxRetries`, default `{maxRetries: 3, retryDelay: 100}` (fs.rm's native transient-error retry). Guard, audit, and error propagation unchanged.

## Decision-point inventory

- `withRmRetryDefaults` — added — fills only `undefined`; explicit values (incl. 0) win.
- `safeRm` / `safeRmSync` — modified — options pass through the helper.
- `safeRmdirSync`, `safeUnlink*`, guard/audit paths — untouched.

## Direction of failure

- Old: a transient ENOTEMPTY/EBUSY race failed the delete immediately (CI flake class; live shard failure 2026-06-05).
- New: up to 3 retries over ~300ms; a PERSISTENT error still throws identically (same error, same audit 'denied' record).
- Conservative direction: deletes the caller asked for succeed slightly more often; nothing is deleted that wasn't requested — the guard runs BEFORE any retry and the target path never changes.

## Side-effects checklist

1. **Latency:** worst case +300ms on a genuinely failing recursive delete — negligible against the operations involved.
2. **Semantics:** retry only widens the success window of the SAME operation; no new deletion scope. SourceTreeGuard evaluation is unaffected (it runs once, before).
3. **Race-with-writer behavior:** a writer that keeps writing past the window still fails the delete with the original error — honest failure preserved.
4. **Caller control:** explicit `maxRetries` (incl. 0 for fail-fast) is never overridden — pinned by test.
5. **Funnel placement:** single chokepoint benefits every existing and future caller — no per-callsite churn.
6. **External surfaces:** none.
7. **Rollback:** revert; behavior returns to fail-fast.

## Scope not taken

- No retry on safeUnlink/safeRmdirSync (single-entry ops don't exhibit the tree-walk race).
- No backoff tuning knob (constants suffice; revisit only with evidence).

## Rollback

Revert the commit.
