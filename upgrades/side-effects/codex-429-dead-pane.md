# Side-Effects Review — Codex 429 dead-pane reporting

**Version / slug:** `codex-429-dead-pane`
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** independent lifecycle reviewer

## Summary of the change

Tier 1, eight files and a small reversible lifecycle correction. A retained dead Codex pane with a nonzero exit and explicit HTTP 429 Too Many Requests text becomes a failed session, not a completed one. The existing scheduler records a failed run and releases capacity; the existing dead-job cleanup removes the pane. A one-time exit event feeds a high-priority Attention item, degradation report, and topic notice. The PR was rebased onto origin/main (version 1.3.1672) in a fresh isolated worktree backed by a fresh clone; remote origin is https://github.com/JKHeadley/instar.git. Rebase preserves both the main-branch and Codex self-action controllers. The repair adds a shared terminal-evidence parser and regression coverage; rollback remains a revert.

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

- [x] No — the terminal signature produces a cause signal at a confirmed dead-process boundary. The terminal result and explicit 429 text together select this scoped failure classification; the text never controls a live process. Other terminal failures retain their existing classification.

## 4b. Judgment-point check

No static heuristic decides among competing live-session signals. A dead pane and nonzero process exit are enumerable OS facts. The output pattern only refines the cause after death.

## 5. Interactions

- **Shadowing:** The live-prompt RateLimitSentinel cannot handle an exited process; this path runs after death.
- **Double-fire:** The persisted status changes off `running` before the event, so later ticks cannot re-emit it. Scheduler failure alerts may also fire under their existing threshold; their message describes the job, while the new Attention item identifies the immediate cause.
- **Terminal-status race:** tmux can close its pane fd before waitpid publishes a status. Empty status is unknown, never zero. All three liveness paths wait for a numeric exit status or terminal signal; the separate dead-pane read also refuses to cache an empty status as zero. A real-tmux fixture closes its descriptors and waits on a release file, proving the session remains running until its eventual nonzero result. Signal-terminated panes remain terminal without a numeric status.
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
**Independent read of the artifact:** original review concurred after the capture/CAS race and listener isolation fixes. Repair review by `/root/lifecycle_review` concurs with the shared terminal-evidence parser, pending-status regression, signal handling, both real-tmux modes, negative cases and repeated-tick bound; final artifact and repaired diff independently reviewed and concurred, with no blocking concerns.

## Evidence pointers

`tests/unit/dead-job-pane-cleanup.test.ts` uses private real-tmux sockets with no host config, in both legacy and bounded async modes. It covers 429 failure after startup, delayed exit status with a real process, clean Codex exits carrying stale error text, other errors/frameworks, repeated ticks, operator-kill races and listener faults. `tests/unit/session-manager-is-session-alive-async-tristate.test.ts` reproduces pending-status failure before the repair in both modes and covers signal exits. The convergence ratchet passes 531 cases. TypeScript passes. Full check results are recorded in the PR description.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registry model drives a sustained dead Codex pane for N and 2N monitor ticks and across reconstruction; the persisted running-to-failed transition permits one notice for that session and stops subsequent emissions }`. `tests/unit/dead-job-pane-cleanup.test.ts` verifies the real status transition and one event.

## Repair scope and effort

Tier 1, narrow reversible bug repair. One independent review, deterministic red/green status-race regression, real-tmux reproduction, and targeted lifecycle/convergence verification. No constitution file is changed. No migration or new retry authority.

## tmux portability correction

Peer verification found two failures in the new real-process timing fixture: tmux 3.7 reports `pane_dead=0` until process exit, whereas 3.4 can report `1` when descriptors close. The fixture now synchronizes on a file written after descriptor closure, accepts either documented observation while requiring an unknown exit status, and still requires running state before release followed by one failed 429 result, one notice and pane cleanup. No assertion about Instar outcomes is removed; the deterministic probe test still exercises `pane_dead=1` with an empty status in both modes. Both tmux versions are verified before pushing this correction.

Independent repair review by `/root/lifecycle_review`: concur. The ready file reliably marks descriptor closure; every Instar outcome assertion remains; the deterministic pending-status test is unchanged. No blocking concern.
