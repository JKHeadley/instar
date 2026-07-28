# Side-Effects Review — JobRunHistory row-cap dedup

**Version / slug:** `jobrunhistory-row-cap-dedup`
**Date:** `2026-07-09`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`src/scheduler/JobRunHistory.ts` now handles oversized job-run rows by fitting an oversized `error` field into the 2 KB row cap with head and tail detail preserved, after dropping bulkier non-diagnostic fields. It also deduplicates the existing `JobRunHistory.appendLine` degradation per `(slug + row-size-cap condition)` for a rolling one-hour window, updating the in-memory event count instead of appending one health event per retry-loop failure. Tests live in `tests/unit/JobRunHistory.test.ts`.

## Decision-point inventory

- `JobRunHistory.applyRowSizeCap` — modified — decides how to fit a run-history row under the existing storage cap.
- `JobRunHistory.reportRowCapDegradation` — added — decides whether to emit a new DegradationReporter event or update the existing same-slug window event.

## 1. Over-block

No block/allow surface. The change does not reject user input, stop jobs, or prevent writes. The row still writes; only bulky fields are shortened to satisfy the existing cap.

## 2. Under-block

A process restart clears the in-memory dedup window, so the first capped row after restart emits a new degradation even if the same slug was noisy before restart. That is acceptable because a restart is a new health episode and the event volume is still bounded per process window.

## 3. Level-of-abstraction fit

This is at the storage/observability layer that owns the row cap. It does not create a parallel health system; it continues to emit through `DegradationReporter` and only shapes duplicate events before they enter `/health`.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The dedup logic is a bounded observability signal, not an authority. It cannot block a job, hide a failure row, or approve an action. It only prevents identical cap-hit reports from flooding the health surface while keeping the existing DegradationReporter path.

## 5. Interactions

- **Shadowing:** It runs inside the existing row-size cap path, before the reporter call. No other cap reporter is shadowed.
- **Double-fire:** Same slug plus same cap condition inside the one-hour window updates the existing event rather than double-firing. Different slugs and expired windows still fire separately.
- **Races:** The dedup map is process-local and synchronous in the append path. There is no async shared-state mutation.
- **Feedback loops:** The report count updates the health event text but does not feed back into scheduler retries or job execution.

## 6. External surfaces

The `/health` degradation summary becomes quieter: repeated capped rows for one failing job appear as one JobRunHistory degradation with an increasing count. The persistent job-run JSONL rows still append normally, and oversized errors remain visible in shortened form. No Telegram, Slack, GitHub, Cloudflare, route, config, or operator-action surface changes. No operator-facing actions are added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. Job run history and health degradations are per running agent/server process today; this change preserves that posture. It emits no user-facing notices directly, holds no new durable cross-machine state, and generates no URLs. If the same slug fails on two machines, each machine reports its own local cap episode.

## 8. Rollback cost

Hot-fix release: revert the code and tests. No migration is needed. Rows written by this change are normal JSONL rows with the existing capped-row flag and string fields, so older readers continue to parse them.

## Conclusion

Clear to ship. The change resolves both halves of the observed failure: `/health` no longer floods with one JobRunHistory degradation per retry-loop row, and the stored capped row still preserves the diagnostic error text needed to debug the underlying job failure.

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

## Evidence pointers

- `instar dev:claim-check src/scheduler/JobRunHistory.ts` — clean, no sibling claim.
- `npm test -- tests/unit/JobRunHistory.test.ts` — 38/38 passing.
- `npm run lint -- --help` — passed; report-only existing ratchets remained non-blocking.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller addition — not applicable.
