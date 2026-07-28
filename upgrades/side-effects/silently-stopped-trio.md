# Side-Effects Review — Silently-stopped trio

**Version / slug:** `silently-stopped-trio`
**Date:** 2026-05-22
**Author:** echo
**Second-pass reviewer:** [pending — high-risk: WorktreeManager + new sentinels]
**Spec:** [docs/specs/silently-stopped-trio.md](../../docs/specs/silently-stopped-trio.md)
**ELI16:** [docs/specs/silently-stopped-trio.eli16.md](../../docs/specs/silently-stopped-trio.eli16.md)

## Summary of the change

Three independent layers closing the same failure class — "agent silently stopped working without anyone noticing" — diagnosed jointly with the gsd-side echo agent on 2026-05-22.

1. **WorktreeManager clone-default** (`src/core/WorktreeManager.ts`). New private predicate `shouldCloneInsteadOfWorktree()` returns true when source `projectDir` is outside agent home (the sandbox-revocation hazard case). When true, `createBinding` uses `git clone` + `git checkout -b` instead of `git worktree add`, producing a fully self-contained `.git/` directory under agent home. `INSTAR_WORKTREE_FORCE_WORKTREE=1` is the rollback escape hatch. The existing in-tree worktree path (source already under agent home) is preserved unchanged.

2. **SocketDisconnectSentinel** (`src/monitoring/SocketDisconnectSentinel.ts`, new). Detector + recovery for Claude Code's `socket connection closed unexpectedly` family of strings. Mirrors `RateLimitSentinel`'s shape — detect, immediate user notice, backoff staircase, verify, escalate. Patterns are intentionally broad (4 regex variants) because false-positives are cheap nudges and false-negatives are the exact failure class this exists to close.

3. **ActiveWorkSilenceSentinel** (`src/monitoring/ActiveWorkSilenceSentinel.ts`, new). Walks the SessionRegistry every 60s; reports any session whose `lastOutputAt` is older than the silence threshold (default 15 min). One nudge (empty `tmux send-keys`), 30s verify, escalate via tone-gated `/attention` if no advance.

All three escalation payloads route through the existing `MessagingToneGate` B12-B14 ruleset via `/attention` (`category: degradation`).

## Decision-point inventory

- `WorktreeManager.shouldCloneInsteadOfWorktree` — **add** — structural predicate (file shape + env override).
- `WorktreeManager.createBinding` clone branch — **add** — uses `git clone` + `git checkout -b` for cross-project sources.
- `SocketDisconnectSentinel.report / scanSession / runAttempt / verifyAttempt / escalate` — **add** — full recovery state machine.
- `ActiveWorkSilenceSentinel.tick / report / runNudge / verifyNudge / escalate` — **add** — silence-detection state machine.
- Tone-gated `/attention` POST path — **pass-through** — consumed by both new sentinels' notify functions; the gate (existing authority) is unchanged.

## Deferrals tracked

The v3 Self-Healing Remediator's Tier-3 absorption of these sentinels' detection + recovery surfaces is the only forward note. <!-- tracked: topic-3079-v3-remediator -->

---

## 1. Over-block

- **Worktree decision over-broad.** Any source outside agent home triggers clone. False-positive cost: a `git clone` takes 1-5s on APFS (sub-second with CoW). False-negative cost: the exact incident class we just hit. Acceptable.
- **Socket-disconnect regex over-broad.** Patterns include generic `connection.*closed.*unexpectedly` — could match unrelated text. False-positive cost: one Ctrl+C+Enter nudge to a healthy session + a "lost its connection" Telegram message that resolves cleanly. False-negative cost: silently frozen session. Trade-off documented.
- **Silence threshold over-broad.** 15 min is conservative; agents doing slow LLM work (e.g. 5-min generation cycles) could trip if they go quiet during a long thinking pause. Mitigation: the `paused` / `recoveryInFlight` flags let SessionRegistry callers exempt sessions in known-quiet states. Configurable per-deployment.

## 2. Under-block

- **WorktreeManager migration of EXISTING worktrees.** This PR ships the clone-default for NEW bindings. Migration of existing worktrees-on-disk is deferred — the spec discussed it but it requires significant safety work (rsync of uncommitted diffs, fencing during the swap). Tracked: same v3 Remediator absorption point. <!-- tracked: topic-3079-v3-remediator -->
- **Socket-disconnect pattern coverage.** Claude Code may surface other disconnect strings we don't yet know about. Patterns are extensible; the next observed string adds one line.
- **Active-work-silence false-negatives.** Sessions that produce minimal output (e.g. a `wait + retry` loop with tiny intervals) might never trip the 15-min threshold even when "stuck" in some other sense. Adjacent watchdogs (SessionWatchdog, PresenceProxy) cover other shapes.
- **Both sentinels currently fire-and-forget on escalation.** No retry-the-escalation loop. If the notify fails (network blip, tone gate hiccup), the message is lost. Acceptable for v1 — the bigger problem (silent failure) is closed; retry plumbing comes with v3 Remediator.

## 3. Level-of-abstraction fit

- **WorktreeManager** is the right layer — it's the single funnel that decides how to materialize a worktree on disk. Putting the clone-vs-worktree decision anywhere else would skip the existing fencing + binding lifecycle.
- **Sentinels in `src/monitoring/`** alongside RateLimitSentinel, CompactionSentinel, SessionWatchdog. Same idiom; same wire-up shape via server.ts.
- **Escalation through `/attention`** uses the existing tone gate — no new judgment authority introduced.

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces signals consumed by an existing smart gate.**

- `shouldCloneInsteadOfWorktree` is a structural predicate (file path + env). No judgment.
- `SOCKET_DISCONNECT_PATTERNS` regex is a detector. State machine is a bounded mechanic (fixed attempt count, fixed backoff staircase).
- `ActiveWorkSilenceSentinel.tick` threshold is deterministic. Nudge is a bounded primitive.
- All user-facing escalation goes through `MessagingToneGate` via `/attention`'s existing path. No new authority introduced.

## 5. Interactions

- **Shadowing:** SocketDisconnectSentinel and ActiveWorkSilenceSentinel can both fire on the same session (socket dropped → output stopped). The socket sentinel ticks every 15s; the silence sentinel waits 15 min. Socket sentinel virtually always fires first. Idempotency-by-id in `/attention` prevents duplicate topic creation if both ever land.
- **Double-fire vs existing watchdogs:** SessionWatchdog (long-running child), SessionMonitor (topic-bound output gap), PresenceProxy (user-waits-for-agent). All three handle different shapes; none overlap with the new sentinels in practice. Active-work-silence is the catch-all for what falls through the cracks.
- **Races:** Sentinel state maps are per-session keys; concurrent ticks on the same server can't race (single-threaded JS event loop). Cross-process safety is N/A — each server instance is a single sentinel owner.
- **WorktreeManager clone vs worktree-add:** Mutually exclusive code paths; no race.

## 6. External surfaces

- **Other agents:** Bindings created by this PR for shared repos will be clones, not worktrees. `git worktree list` from the source repo won't show them. Documented in CLAUDE.md template (forward).
- **Other users:** ships in next release. macOS users + Linux users alike. The clone path is OS-agnostic.
- **External systems:** Telegram (one extra topic class — "disconnect" alerts — though tone-gated). `/attention` route — existing; no change to its contract.
- **Persistent state:** No new files for the sentinels (in-memory state only — by design, simpler than RateLimitSentinel which persists). WorktreeManager bindings file unchanged.
- **Timing:** Sentinel ticks (15s + 60s) are negligible overhead per session.

## 7. Rollback cost

- WorktreeManager: revert the diff. `INSTAR_WORKTREE_FORCE_WORKTREE=1` is the in-place rollback toggle without a release.
- Sentinels: revert each new file + the server.ts wire-up. No persistent state to clean up.
- Total: ~15 min revert + release cycle.

---

## Addendum 2026-05-23 — Smoke-test interaction with SourceTreeGuard (fixed)

After the initial commit landed, `npm run test:smoke` surfaced 14 failures in the existing WorktreeManager test suite — every test that exercised the clone-default branch failed with `SourceTreeGuardError: Refusing to run src/core/WorktreeManager.ts:clone-default against the instar source tree`. Root cause: `SafeGitExecutor.runSourceTreeChecks` defaults the target list to cwd. The new `git clone` call ran from a cwd that happened to be inside the instar source tree (test fixtures invoking `createBinding` from inside an instar checkout), and the guard correctly flagged the cwd as destructive-against-source even though the clone op itself is non-destructive on the source. **Fix:** pin `cwd: this.worktreesRoot` on the clone call — guaranteed outside the source tree and the same dir the clone destination lives under. All 56 smoke tests pass.

This is a defensible interaction, not a guard regression: the guard is doing exactly what it was built to do (conservative protection of the source tree). The clone-default branch needed explicit cwd because it's the first WorktreeManager codepath to run git from outside the source's own dir.

## Conclusion

Closes the silently-stopped failure class in one PR per the no-deferrals rule. 34 new tests cover the core surfaces. Server-side wire-up + integration tests + CLAUDE.md template update are part of this PR (see commit). Tone-gate compliance asserted at unit level for both sentinels' escalation payloads. Migration of existing worktrees explicitly deferred to v3 Remediator with tracker marker.

Clear to ship pending second-pass review.

---

## Second-pass review (if required)

**Reviewer:** [pending]

[awaiting reviewer]

---

## Evidence pointers

- Spec: `docs/specs/silently-stopped-trio.md` + `.eli16.md`.
- Tests: `tests/unit/monitoring/SocketDisconnectSentinel.test.ts`, `tests/unit/monitoring/ActiveWorkSilenceSentinel.test.ts`, `tests/unit/core/WorktreeManager-clone-default.test.ts` — 34 tests.
- Incident reference: topic 5447 alignment with gsd-side echo's diagnosis 2026-05-22.
