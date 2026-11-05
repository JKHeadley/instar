# Side-Effects Review — Codex 429 dead-pane reporting

**Version / slug:** `codex-429-dead-pane`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent lifecycle reviewer

## Summary of the change

Tier 1, eight files and a small reversible lifecycle correction. A retained dead Codex pane with a nonzero exit and explicit HTTP 429 Too Many Requests text becomes a failed session, not a completed one. The existing scheduler records a failed run and releases capacity; the existing dead-job cleanup removes the pane. A one-time exit event feeds a high-priority Attention item, degradation report, and topic notice. One design review round and two test iterations.

## Decision-point inventory

- `SessionManager` self-exit classification — modify — classify confirmed Codex 429 as failure.
- `JobScheduler` failure summary — modify — name the recorded cause.
- Server exit-event listener — add — report the failure to existing alert and topic surfaces.
- Self-action registry — add — model the one-notice-per-session settling bound.

## 1. Over-block

A stale 429 line in the last 60 pane lines followed by a different nonzero Codex failure could be classified as rate-limited. The pane must also be confirmed dead with a nonzero exit code; this possibility affects the reason label, not whether work is running.

## 2. Under-block

A Codex 429 phrased without both `429` and `Too Many Requests`, or a pane whose output cannot be read, is handled as an ordinary exit. The existing dead-pane liveness check still removes it from running status. The Attention item is best effort if Telegram is down; the degradation report and log retain the signal.

## 3. Level-of-abstraction fit

The tmux probe supplies objective process and exit evidence. SessionManager owns the status transition; JobScheduler consumes that status; server wiring owns user-facing delivery. No separate liveness authority is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the terminal signature produces a cause signal at a confirmed dead-process boundary. The objective dead-pane and nonzero-exit evidence determines failure; the string only selects the specific reason and alert wording.

## 4b. Judgment-point check

No static heuristic decides among competing live-session signals. A dead pane and nonzero process exit are enumerable OS facts. The output pattern only refines the cause after death.

## 5. Interactions

- **Shadowing:** The live-prompt RateLimitSentinel cannot handle an exited process; this path runs after death.
- **Double-fire:** The persisted status changes off `running` before the event, so later ticks cannot re-emit it. Scheduler failure alerts may also fire under their existing threshold; their message describes the job, while the new Attention item identifies the immediate cause.
- **Races:** The compare-and-set reread runs after the new awaited terminal capture, so another killer changing status during that probe keeps its verdict.
- **Feedback loops:** No automatic respawn is triggered, so no retry loop is created.

## 6. External surfaces

The session and job status now show failure for a confirmed Codex 429. Attention and the bound Telegram topic receive a direct notice. The current job's files may contain partial work; the notice asks for a deliberate retry on another account or after reset. No new operator action is introduced.

## 6b. Operator-surface quality

No operator surface file is changed — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: only the machine hosting a tmux pane can prove that process exited. The existing session and job status surfaces carry the outcome; the existing Attention channel and topic routing carry the notice. The event is emitted once per local session incarnation. No URL or new durable store is added. No `/status`, `/health`, `/capabilities`, or `/channels` answer is changed directly.

## 8. Rollback cost

Revert and ship a patch. Completed failed-run records remain historical evidence; no migration or state repair is needed. During rollback, new Codex 429 exits would again be mislabeled until the patch returns.

## Conclusion

The change is scoped to objectively dead Codex processes and reuses existing job and alert paths. It reports rather than automatically replays potentially partial fixer work. The independent lifecycle review found and resolved a capture/CAS race and alert-listener fault isolation issue. Ready for CI.

## Second-pass review

**Reviewer:** independent lifecycle reviewer
**Independent read of the artifact:** concur after the capture/CAS race test was corrected to exercise a session older than the startup window. The alert event uses the existing per-listener isolation helper.

## Evidence pointers

`tests/unit/dead-job-pane-cleanup.test.ts` uses a private real-tmux socket (8 passing cases, including the race and listener-fault cases); `tests/unit/self-action-convergence.test.ts` passes (520 cases); `npx tsc --noEmit` passes.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registry model drives a sustained dead Codex pane for N and 2N monitor ticks and across reconstruction; the persisted running-to-failed transition permits one notice for that session and stops subsequent emissions }`. `tests/unit/dead-job-pane-cleanup.test.ts` verifies the real status transition and one event.
