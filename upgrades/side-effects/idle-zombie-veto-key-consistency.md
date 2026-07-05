# Side-Effects Review — Idle-Zombie Veto-Backoff Key Consistency

Spec: `docs/specs/idle-zombie-veto-key-consistency.md` (converged, approved)
Change: `src/core/SessionManager.ts` — `computeIdleZombieReapVerdict` now mirrors
`terminateSessionInternal`'s skip-reason precedence (`protected` → lease-gate `not-lease-holder`
→ reapGuard) so the veto-backoff pre-check keys the cooldown on the SAME reason `recordVeto`
stores. Plus 3 Tier-1 tests in `tests/unit/session-manager-idle-veto-backoff.test.ts` (a
load-bearing standby-spin repro, a real-`terminateSessionInternal`-as-oracle equivalence property
test, and an `isAwakeMachine`-unset guard test).

**Decision point?** Yes — this touches the idle-zombie kill-eligibility DECISION path. It is a
SIGNAL fix: it corrects which reason KEY the veto-backoff ledger uses; it does NOT change the kill
AUTHORITY (that stays entirely in `terminateSessionInternal`, which independently re-applies the
lease gate). The pre-check only decides "have I already backed off?" — never "may I kill?".

1. **Over-block** — Does it reject a legitimate kill it shouldn't? No. On the awake machine the
   standby branch is skipped (`!this.isAwakeMachine()` is false) and behavior is byte-identical to
   today; a session with no keep-reason is still killed on the first attempt (existing test 2 still
   green). The fix only makes a STANDBY machine's cooldown actually HOLD — it was already declining
   to kill (a standby never reaps another machine's sessions); the fix stops the wasteful re-attempt
   spin, not a legitimate kill.

2. **Under-block** — Failure modes it still misses? The residual transient reasons `in-flight` and
   `already-<status>` are deliberately NOT mirrored (they are non-recurring by construction — a
   one-tick mismatch re-evaluates once, never a sustained spin; both are absent from
   `IDLE_ZOMBIE_ESCALATION_REASONS`, so no false P19 escalation). The `in-flight`-flap bound is
   asserted by a Tier-1 test. A future terminate skip-reason added BEFORE the lease gate is caught
   by the equivalence property test's classification-completeness assertion (it forces a
   mirrored-or-residual decision rather than silently going green).

3. **Level-of-abstraction fit** — Right layer? Yes. The fix lives in the pre-check that already owns
   the reason-key derivation. A "single source of truth" shared helper (extract
   `computeAutonomousSkipReason` and have both paths call it) was considered in convergence and
   rejected as an unclean pure extraction — `terminateSessionInternal`'s skip logic interleaves with
   `origin` bypass, a five-flag bypass set, `knownDead`, CAS `already-*`, and the live
   `this.terminating` Set — a wide refactor of the most safety-critical method for a cooldown-key
   fix. The equivalence property test gives the shared-helper's drift-guarantee without the blast
   radius.

4. **Signal vs authority** — Compliant. The change produces/uses a SIGNAL (the cooldown key); the
   blocking AUTHORITY (kill vs skip) remains in `terminateSessionInternal`, unchanged and
   independently re-evaluated. `blocked` stays the raw reapGuard verdict; only `reasonKey` is
   overridden, preserving the C2/R4-2 single-guard-eval threading.

5. **Interactions** — Does it shadow/double-fire/race? No new race (the monitor tick is
   single-threaded; the fix adds a synchronous branch before the existing await point). It does NOT
   change the age-gate `VetoedKillBackoff` instance (that keys via its own 2-arg callsites). The
   escalation gate keys on `vetoKey` (= the stored terminate reason), same source as `recordVeto` —
   no divergence introduced.

6. **External surfaces** — None. No API route, no config schema change, no dashboard surface, no
   agent-facing message. The only observable behavior change is FEWER log lines / terminate attempts
   on a standby machine (the spin stops).

7. **Multi-machine posture (Cross-Machine Coherence)** — `machine-local BY DESIGN`
   (`machine-local-justification: hardware-bound-resource`). The `VetoedKillBackoff` ledger is a
   per-process in-memory Map guarding THIS machine's own tmux/session inventory (hardware-bound); no
   replication, no proxied read, no cross-machine surface. On a single-machine agent
   `isAwakeMachine()` returns awake → the standby branch is skipped → strict no-op.

8. **Rollback cost** — Trivial. Revert the one method (three-branch → one-line). No data migration,
   no state repair. The parent config knob `monitoring.idleKillVetoBackoff.enabled` still gates the
   whole ledger; when disabled the corrected key is never consulted. No hot-fix coupling.

**Migration Parity:** N/A — pure runtime code fix to one private method; changes no installed file
(no `.claude/settings.json`, config default, CLAUDE.md template, hook, or skill). Existing agents
receive it via the normal version bump.
