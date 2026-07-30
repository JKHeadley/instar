# Side-Effects Review — a delivered headless spawn must not report failure

**Version / slug:** `spawn-postdelivery-bookkeeping-truth`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `spawn-truth-review (independent Codex reviewer)`

## Summary of the change

`SessionManager.spawnSession()` creates a headless tmux session with the full prompt in its launch argv, then persists the session record. The persistence call was outside the launch `try/catch`, so a state-write exception rejected the method after delivery had already occurred. This change catches only that post-delivery bookkeeping exception, reports the degradation, and returns the live `Session`. The real tmux-creation failure boundary is unchanged. The runtime change is in `src/core/SessionManager.ts`; the discriminating regression is in `tests/unit/headless-spawn-reroute.test.ts`.

Build location was re-grounded before editing: the branch starts at current `upstream/main` `30189100f` (`v1.3.1068`), with `upstream` resolving to `https://github.com/JKHeadley/instar.git` and `package.json` version `1.3.1068`. The worktree helper refused because this running legacy project-bound agent is absent from the new global registry, so an existing clean Instar-owned worktree under this agent's home was switched to a fresh branch at that exact upstream head; no stale branch content or unrelated changes were carried forward.

## Decision-point inventory

- `SessionManager.spawnSession()` post-launch persistence result — **modified** — a state-write exception after successful headless launch now reports degraded bookkeeping and resolves with the already-live session.
- `SessionManager.spawnSession()` tmux launch result — **pass-through** — failure before the terminal session exists still rejects through the existing launch `try/catch`.
- `SpawnRequestManager` spawn-failure retry decision — **interaction only** — it no longer receives a false rejection for an already-delivered headless prompt, preventing an unsafe redrive.

---

## 1. Over-block

**No new rejection surface.** The change removes one false rejection after delivery. Legitimate launch failures, session-cap refusals, worktree-lock failures, and tmux-name collisions remain byte-for-byte on their existing rejecting paths.

---

## 2. Under-block

Framed as under-fix because this change does not block:

1. A live headless session whose first state write fails is absent from persisted monitoring, session counts, dashboard reads, kill-by-id, and normal cleanup. `OrphanProcessReaper` classifies the unknown tmux name as external rather than adopting it, so there is no later automatic reconciliation: it can survive restart indefinitely until manually cleaned up. The structured degradation report includes the exact tmux name and session id and states this consequence. Returning failure would not repair the missing state; it would add duplicate-delivery risk, so this orphan posture is the explicitly accepted lower-risk outcome.
2. The rerouted-interactive path is intentionally unchanged. It creates a live REPL, saves state, and only then injects the prompt asynchronously. A state-write failure there does **not** prove prompt delivery, so the headless truth rule cannot honestly be copied to that path.
3. `StateManager.saveSession()` can mutate older duplicate-name records through best-effort stale-record supersession before the new record's atomic write fails. It does not publish a partially written new record: the new file is written through a temp-file rename, lifecycle-journal emission is non-throwing, and cache invalidation follows only after the atomic write returns. The accepted degraded shape is therefore an untracked live process, potentially alongside already-superseded older records.

---

## 3. Level-of-abstraction fit

This is the correct layer. `SessionManager.spawnSession()` is the only function that knows the ordering of the two events: successful tmux creation with the prompt, then state persistence. `SpawnRequestManager` cannot safely reconstruct that truth from a generic exception or from persisted state, because persisted state is the operation that failed. Fixing the return contract at the source lets every caller distinguish actual launch failure from post-delivery bookkeeping failure without new error-string matching, probing, or duplicate recovery machinery.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The boundary is an enumerable ordering invariant, not a judgment about message meaning: after `execFileSync(tmux new-session …prompt)` returns successfully, delivery has occurred; before it returns, delivery is not claimed. No detector, heuristic, threshold, or conversational authority is added. The existing structured degradation reporter receives the bookkeeping failure as an observation.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** The choice depends on a single causal boundary in one synchronous function: whether the tmux creation call already returned successfully. There are no competing liveness, ownership, urgency, or conversation signals to arbitrate.

---

## 5. Interactions

- **Shadowing:** the new catch surrounds only `state.saveSession(session)` after the headless launch block. It cannot shadow tmux creation errors, worktree resolution errors, reroute admission refusals, or pre-launch validation.
- **Double-fire:** this closes a double-fire hazard. A caller that receives success does not enter its spawn-failure retry path, so one delivered prompt stays one delivery.
- **Races:** no shared state, timer, or asynchronous step is added. The tmux launch and state write remain synchronous and ordered.
- **Adjacent retry path:** `SpawnRequestManager` still treats genuine `spawnSession` rejection as non-delivery. This fix makes that assumption true for the headless post-launch state-write case that previously violated it.
- **Monitoring:** a failed first state write leaves an untracked live process outside caps, dashboard reads, kill-by-id, `SessionManager` monitoring, and `OrphanProcessReaper` reconciliation. It may survive restart indefinitely. The change does not conceal that; it emits a direct error plus `DegradationReporter` containing the exact tmux name and session id. No blind retry is attempted because the original failure may be a durable write guard or filesystem failure, while stale-record supersession may already have changed older records.
- **Interactive reroute:** deliberately not covered. That path has not injected the prompt at its save boundary, so preserving its current rejection avoids falsely claiming delivery.

---

## 6. External surfaces

- **Other agents and callers:** they now receive a successful spawn result when their headless prompt is already running, instead of an exception that encourages unsafe retry.
- **Install base:** every updated agent receives the corrected return semantics. There is no config flag because reporting an already-delivered operation as failed is never a desirable mode.
- **External systems:** no API, Telegram, Slack, GitHub, Cloudflare, or protocol shape changes.
- **Persistent state:** no new schema or store. The handled failure is specifically a failure to write the existing session record.
- **Timing/runtime conditions:** no new timing dependency. The boundary is the synchronous return of tmux session creation.
- **Operator surface:** no operator-facing action is added or changed.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface — not applicable.**

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A tmux session and its state file are facts about the machine that launched the process. The corrected result applies independently on whichever pool machine owns and executes the spawn; it does not create replicated state or authorize another machine to retry the same prompt.

- **User-facing notices:** none; only existing machine-local logs and degradation reporting, so no one-voice user notice is added.
- **Durable state/topic transfer:** no new durable state. A failed first session-state write leaves the process machine-local, untracked, and not automatically reconciled even after restart; the identified degradation event is the only action surface. This change prevents that condition from also producing a cross-machine duplicate delivery.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert the catch/report block and the regression test, then ship the next patch.
- **Data migration:** none.
- **Agent state repair:** none introduced. Any session record that failed before or after this fix follows the existing machine-local recovery/cleanup posture.
- **User visibility:** rollback would restore the rare false-failure/duplicate-redrive risk during the propagation window.

---

## Conclusion

The change is narrow and matches the actual delivery boundary: successful headless tmux creation means the prompt is already running, while earlier failures remain failures. Review preserved two explicit tradeoffs: the interactive reroute path cannot use the same rule because its prompt injection happens after persistence, and a first-write failure leaves an indefinitely untracked machine-local process. The latter is now identified by session id and tmux name in the degradation report and is accepted as less dangerous than duplicating an already-running instruction.

---

## Second-pass review (required)

**Reviewer:** spawn-truth-review (independent Codex reviewer)
**Independent read of the artifact:** concur

The reviewer confirmed the synchronous headless delivery boundary, unchanged pre-delivery rejection path, duplicate-redrive prevention, and deliberate exclusion of rerouted-interactive. Its first read raised the indefinite-orphan and actionability gaps; after the artifact and degradation event were corrected to name the session and accept the true cleanup posture, the reviewer concurred.

---

## Evidence pointers

- Pre-fix focused run: 25 passed, 1 failed; the new regression alone failed on the escaped simulated state-write exception.
- Post-fix focused run: 26/26 passed.
- Adjacent verification: 131/131 passed across headless spawn, spawn request management, framework portability, interactive cap, and no-silent-fallback suites.
- `npm run lint`: passed, including `tsc --noEmit` and the complete lint chain.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller added or modified — not applicable.
