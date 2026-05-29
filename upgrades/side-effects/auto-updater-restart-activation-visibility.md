# Side-Effects Review — AutoUpdater restart activation visibility

**Version / slug:** `auto-updater-restart-activation-visibility`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `Justin review requested in PR`

## Summary of the change

This change narrows AutoUpdater restart blockers and makes activation waits observable. `src/core/UpdateGate.ts` now ignores a running job session only when it has a `jobSlug`, a tmux session name, and `SessionManager.hasActiveProcesses(tmuxSession)` says no real non-baseline process is running. `src/core/AutoUpdater.ts` persists a restart-wait object with target version, first wait time, reason, blockers, next retry, and updated time. `src/server/routes.ts` surfaces that object on authenticated `/health` and `/updates/status`. Tests cover safe idle jobs, active jobs, interactive session conservatism, AutoUpdater state persistence, and health output.

## Decision-point inventory

- `UpdateGate.canRestart` — modify — decides whether an update-driven server restart can proceed now or must wait.
- `AutoUpdater.gatedRestart` — modify — records and clears restart-wait state around the existing restart decision.
- `GET /health` and `GET /updates/status` — modify — surface restart-wait state; no blocking authority.

---

## 1. Over-block

The main remaining over-block is intentional: interactive sessions still block when the monitor reports them healthy, even if a process-tree check would say no active child work. Justin explicitly held the bounded restart policy for interactive sessions, so this PR does not relax that path. Background job sessions also still block when `hasActiveProcesses` is unavailable or fails, because the safe-idle proof is missing.

---

## 2. Under-block

A background job could be incorrectly treated as idle if `hasActiveProcesses` misses a real work process. That risk already exists anywhere the process-tree ground truth is used, but this PR limits reliance to sessions that are explicitly job-spawned and still fails closed when the method is unavailable. A job that is about to start work but has not spawned a non-baseline child yet may be restarted; that is acceptable for the requested "idle/between-runs" class and no different from restarting before a scheduled job fires.

---

## 3. Level-of-abstraction fit

The restart decision belongs in `UpdateGate`, which is already the authority for update-driven restart gating. This change does not add a parallel gate. It feeds the existing authority a stronger low-level signal: the already-established process-tree active-work check. AutoUpdater owns persistence and user/operator visibility, so persisting `restartDeferral` there is the right layer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

`hasActiveProcesses` is a detector-like primitive, but it does not become a standalone blocker or allower. Its output is consumed by the existing restart authority in `UpdateGate`, and only for job sessions where the distinction between idle and executing is mechanically meaningful.

---

## 5. Interactions

- **Shadowing:** The safe-idle job check runs before session-health classification, but only for `jobSlug` sessions with process-tree proof. It does not shadow interactive session health.
- **Double-fire:** Persisting `restartDeferral` writes the same AutoUpdater state file already used for updater state. It does not write restart-requested signals and cannot trigger a restart by itself.
- **Races:** The persisted restart-wait object is best-effort observability. If a retry fires while status is being read, readers may see the previous `nextRetryAt` until the next state save; this is acceptable and self-correcting.
- **Feedback loops:** The old "already applied" loop guard remains. The log/notification language now distinguishes intentional restart waits from generic activation lag, reducing false manual-restart diagnoses.

---

## 6. External surfaces

Authenticated `/health`, `/updates/status`, and `/updates/auto` now expose additive `restartDeferral` fields. Existing callers that ignore unknown fields continue to work. The state file gains an additive `restartDeferral` object; older versions ignore it. Other agents benefit after update activation because idle background jobs stop holding restarts forever, but active user sessions remain protected.

---

## 7. Rollback cost

Rollback is a hot-fix release that reverts the code and tests. No database migration or state repair is needed. The only persistent addition is JSON in `state/auto-updater.json`; leaving it behind is harmless because older code ignores unknown fields.

---

## Conclusion

The change is narrow and matches the approved scope: safe background-job de-counting plus restart-wait observability. The design explicitly avoids the held interactive-session policy and keeps restart authority centralized in `UpdateGate`. Clear to ship for PR review.

---

## Second-pass review (if required)

**Reviewer:** Justin review requested in PR
**Independent read of the artifact: pending external review**

This touches restart gating, so the PR is intentionally opened for Justin review before merge. I did not implement the held interactive-session restart policy.

---

## Evidence pointers

- `npm test -- --run tests/unit/UpdateGate.test.ts tests/unit/AutoUpdater.test.ts tests/unit/server.test.ts`
- `npm run lint`
- `npm run build`
- `npm run check:upgrade-guide`
- `node scripts/instar-dev-precommit.js`
