# Feedback executor: a failed check run records its own output

## What Changed

- `src/feedback-factory/execute/executePolicy.ts`: new `commandFailureTail(r, { perStream, redact? })` — ONE bounded-tail helper for both places a confined command can fail. `confinementCanary.failureTail` delegates to it (keeping its nonce redaction through the `redact` hook; behaviour byte-identical).
- `src/feedback-factory/execute/FeedbackExecutorService.ts`: `verifyFix`'s four failure returns (`base-check:<reason>`, `head-check:test-fails-at-head`, `gate:lint`, `gate:related-tests`) now carry a bounded tail of the failing command's own output, and a new `recordCheckFailure` persists it — scrubbed and clamped through the same `scrubForStore` + `clampProbeDetail` path the canary latch uses — into `exec:check_failed_last`, surfaced as `status.lastCheckFailure` beside `lastPrepareFailure`. The reason string is untouched: it is prefix-matched elsewhere, so the output goes in its own row rather than being appended to it.

Why: the three check clones are deleted with the attempt, so a failure recorded only `gate:lint` and the cause was unrecoverable afterwards. This is the identical blindness that made the pre-attempt `base-unit-smoke` probe cost three days (2026-10-22 → 2026-10-25) one step earlier, and these four checks sit immediately after it on the path the next attempt takes — so the first real fix attempt would have hit the same dead end. Filed as `fb-ac4a1273-38a`; promoted to in-run work because it gates the current goal rather than merely being adjacent to it.

## What to Tell Your User

When the pipeline checks a fix it has written and one of those checks fails, it now records what the failing command actually printed instead of a bare label. Nothing about what passes or fails changed.

## Summary of New Capabilities

- `GET /feedback-factory/execute/status` → `lastCheckFailure` `{ at, attemptId, reason, detail }`, where `detail` is the failing command's own scrubbed output tail (≤2000 chars). Audit row: `execute:check-failed` (reason only).

## Evidence

`execute-service.test.ts`: a scripted `npm run lint` failure in the gate clone drives a real tick, and the stored `lastCheckFailure.detail` carries both streams' text with the oldest padding dropped, within the durable budget, while the attempt's `reason` stays the clean label `gate:lint`. Mutation-verified three ways — unwiring the recorder fails, dropping the output fails, and head-slicing instead of tailing fails **three** tests including both canary capture tests, which is the proof the bound is shared rather than duplicated. 46 files / 644 tests green; lint and typecheck clean.

One flake run down rather than assumed: `execute-reroute-capacity.test.ts` failed once in a full-suite run, passes 7/7 in isolation both with and without this change, and the suite is green on re-run.
