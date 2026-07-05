---
title: "Idle-Zombie Veto-Backoff Key Consistency (fix-the-fix for the not-lease-holder 5s spin)"
status: draft
parent-spec: "session-respawn-thrash-elimination.md"
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
discovered: "2026-07-05 — autonomous run topic 29836, live server.log evidence"
review-convergence: "2026-07-05T07:13:23.441Z"
review-iterations: 4
review-completed-at: "2026-07-05T07:13:23.441Z"
review-report: "docs/specs/reports/idle-zombie-veto-key-consistency-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (operator, telegram-7812716706) — standing blanket build approval for the 29836 autonomous run (2026-07-04: yes, you drive this); fix-the-fix serving approved parent spec session-respawn-thrash-elimination"
---

# Idle-Zombie Veto-Backoff Key Consistency

## 1. Problem statement

PR #1365 (`session-respawn-thrash-elimination`) shipped the `VetoedKillBackoff` idle-zombie
veto-backoff to stop the 5-second reap-spin. It does NOT work for the dominant real case:
a STANDBY machine's `not-lease-holder` skip. Live evidence (topic 29836, this machine,
2026-07-05): server.log carried **2523** `idle-zombie cleanup vetoed (not-lease-holder) —
backing off re-attempts` WARNs at an **exact 5-second cadence** (all inter-line gaps = 5.0s),
same session, same reason. That WARN is emitted ONLY on the enabled path, gated by
`firstOfEpisode` — so firing every tick proves the cooldown is NOT holding. The visible
symptom (132MB reap-log) was separately contained by PR #1356's log self-limiting, so the
persisting root spin went unnoticed — a silent-loss blind spot.

## 2. Root cause (confirmed from source + proven by the cadence)

Two code paths key the cooldown on DIFFERENT reason sources:

- **Pre-check** `SessionManager.computeIdleZombieReapVerdict(session)` (src/core/SessionManager.ts
  ~L902) computes `reasonKey = normalizeReasonKey(this.reapGuard?.blockedReason(session))`. It
  calls the reapGuard DIRECTLY and never consults the lease gate.
- **Record** in the idle-zombie branch stores `vetoKey = normalizeReasonKey({reason: result.skipped})`
  where `result.skipped` comes from `terminateSessionInternal`.

`terminateSessionInternal` evaluates its skip reasons in this ORDER (src/core/SessionManager.ts,
verified against source): `not-found` → `already-<status>` (~L1285) → `protected` (~L1303) →
**`not-lease-holder`** (the lease gate, `this.isAwakeMachine && !this.isAwakeMachine()`, ~L1314) →
reapGuard-blocked cascade (~L1330-1394) → `in-flight` (~L1399). So on a STANDBY machine the
terminate path SHORT-CIRCUITS at the lease gate and stores `not-lease-holder` — a reason that is
NOT a reapGuard keep-reason (absent from `KNOWN_REAP_KEEP_REASONS`).

When the vetoed session ALSO carries a reapGuard keep-reason (open-commitment / recent-user-message
— common for an active work session), `verdict.reasonKey` = that reapGuard reason while `vetoKey` =
`not-lease-holder`. They differ EVERY tick, so `VetoedKillBackoff.shouldRequest` (VetoedKillBackoff.ts
~L133-144) hits the stale-reprieve branch (`entry.reasonKey != null && reasonKey != null && reasonKey
!== entry.reasonKey → delete + return true`), DELETES the ledger entry every tick, and the 30-minute
cooldown never holds → 5s spin with a WARN every tick. **The spin itself proves the keys differ**
(matched keys ⇒ cooldown holds ⇒ no spin).

**`protected` is already consistent (verified, not assumed):** ReapGuard.blockedReason returns
`'protected'` via `this.deps.protectedSessions().includes(session.tmuxSession)` (ReapGuard.ts ~L143),
and terminateSessionInternal's protected gate tests the SAME set
(`this.config.protectedSessions.includes(session.tmuxSession)`, ~L1303). So a protected session keys
`protected` on BOTH paths — no mismatch — and the fix must PRESERVE that (see §3). **The two sources
are syntactically different (`reapGuard.deps.protectedSessions()` vs `config.protectedSessions`), so
their equivalence is not free — it is a TESTED invariant, not an assumption:** the §4 property test's
`protected+standby` and `protected+awake` cells assert the pre-check key equals the REAL terminate
`result.skipped` (=`protected`), which fails if the two protected sources ever diverge (stale
dependency wiring, a config reload, a mocking mismatch). If a future change makes them diverge, that
test — not production — catches it.

## 3. Fix — RESOLVED to option (a): mirror the terminate skip-reason PRECEDENCE in the pre-check, with a machine-checked equivalence invariant

**Decision (frontloaded — the design fork is closed, not parked).** Convergence considered three
options: (a) mirror the terminate precedence in the pre-check; (b) extract a single
`computeAutonomousSkipReason()` helper that BOTH the pre-check and `terminateSessionInternal`
consume ("single source of truth"); (c) change `VetoedKillBackoff`'s stale-reprieve comparison.
**We adopt (a) PLUS a structural equivalence guard (§4), which is the correct resolution:**

- **(b) is architecturally ideal but NOT a clean pure extraction.** `terminateSessionInternal`'s
  skip determination interleaves with side effects and control-dependent inputs the pre-check
  cannot supply: the `origin` operator-bypass (skips everything), the `bypassedReasons[]` set
  assembled from five opts flags, the `knownDead` skip, the CAS `already-<status>`, and `in-flight`
  which depends on the LIVE `this.terminating` Set (a mid-flight mutable that is meaningless at
  pre-check time and would return reasons the pre-check must NOT gate on). Extracting a shared
  helper would mean a wide, risky refactor of the most safety-critical method in the file for a
  cooldown-key fix — disproportionate and higher-rollback-risk.
- **The Structure > Willpower objection to (a) is real and is answered structurally — not by
  willpower — via §4's equivalence property test.** The concern (two code paths kept in sync by
  discipline is the exact anti-pattern that produced THIS bug) is legitimate. The answer is to make
  the invariant "pre-check reasonKey == the reason terminateSessionInternal would store" a MACHINE
  CHECK in CI (§4), so any future drift (a new terminate skip reason, a reorder) fails a test
  rather than silently re-desyncing. That gives (b)'s guarantee (drift is impossible-to-miss)
  without (b)'s blast radius. Extracting the shared helper later remains a sound refactor, but it is
  an improvement, not a gap this fix leaves open.
- **(c) is rejected:** the stale-reprieve is SHARED with the age-gate 2-arg callsites (which pass
  `reasonKey` undefined→null and never trigger it). The mismatch is UPSTREAM — the two paths
  genuinely MINT different keys; the reprieve is behaving correctly given divergent keys. Fix the
  mint, not the comparison.

**The normative implementation (exact, single algorithm — no menu):**

```ts
private computeIdleZombieReapVerdict(
  session: Session,
  _now: number,   // stays UNUSED — the key must be time-INDEPENDENT (same key every tick)
): { blocked: ReapKeepReason | null; reasonKey: string | null } {
  // Mirror terminateSessionInternal's skip-reason PRECEDENCE so the veto-backoff ledger keys the
  // cooldown on the SAME reason recordVeto will store. Order: protected (a reapGuard reason, and
  // the terminate protected gate tests the same protectedSessions set) BEFORE the lease gate
  // BEFORE the rest of the reapGuard cascade. Equivalence with terminateSessionInternal is
  // enforced by a CI property test (idle-zombie-veto-key-consistency §4), NOT by discipline.
  const blocked = this.reapGuard?.blockedReason(session) ?? null;
  if (blocked?.reason === 'protected') return { blocked, reasonKey: 'protected' };
  if (this.isAwakeMachine && !this.isAwakeMachine()) return { blocked, reasonKey: 'not-lease-holder' };
  return { blocked, reasonKey: normalizeReasonKey(blocked) };
}
```

Load-bearing details the implementation MUST honor:
- **`blocked` stays the RAW reapGuard verdict** — only `reasonKey` is overridden. `blocked` is still
  threaded to `terminateSessionInternal` as `precomputedGuardVerdict.blocked` (the C2/R4-2
  single-guard-eval contract). On standby, terminate returns at the lease gate and never reads
  `blocked` (harmless); on the awake path `blocked` drives the kept-reason exactly as today. NEVER
  null out `blocked` to force key/blocked agreement.
- **`this.isAwakeMachine` presence-guard is mandatory.** `isAwakeMachine` is an OPTIONAL field
  (`private isAwakeMachine?: () => boolean`), unset until `setIsAwakeMachine` wires it (server.ts
  wires it to `() => !coordinator.enabled || coordinator.isAwake`). The pre-check MUST write
  `this.isAwakeMachine && !this.isAwakeMachine()` (presence-guard first) exactly as the terminate
  gate does, or an agent that never wired the callback throws `TypeError` on every idle-zombie tick.
- **Precedence correctness for protected+standby:** because `protected` is checked FIRST (via the
  reapGuard), a protected+standby session keys `protected` on both paths — matching the terminate
  path, which also short-circuits at protected (~L1303) BEFORE the lease gate. The standby override
  sits SECOND, so it only applies to non-protected sessions. This is the exact terminate precedence.

**Residual mismatches (`in-flight`, `already-<status>`) — bounded and non-recurring BY
CONSTRUCTION.** These terminate reasons are not mirrored. They cannot spin because, unlike
`not-lease-holder` (which recurs every tick a standby holds a keep-reason), they are transient:
`already-<status>` fires only for a session whose status is no longer `running`, but the idle-zombie
caller reaches `handleIdleZombie` ONLY from the idle-at-prompt branch, which the monitor tracks
solely for sessions it observed at a running prompt (`idlePromptSince` is set/cleared on that
branch) — so a session that has already transitioned status is not re-driven into this path tick
after tick; and `in-flight` requires a concurrent terminate holding the live `this.terminating`
lock — it clears within a tick or two, so at worst it deletes the ledger entry and re-evaluates
once, never a sustained 5s spin. Both are correctly ABSENT from `IDLE_ZOMBIE_ESCALATION_REASONS`, so
neither can false-escalate the P19 breaker. §4 covers an `in-flight`-flap tick sequence to assert the
bound. (A NARROWER pure helper — extracting only the three side-effect-free gates protected/lease/
reapGuard — was considered and rejected too: it still leaves the transient gates unshared, so it
would NOT remove the equality invariant §4 must enforce, yet it adds a new shared surface and a call
site inside the safety-critical terminate cascade — more blast radius for no additional guarantee
over the §4 property test. The property test is the load-bearing structure either way.)

## 4. Tests (all three tiers; the Tier-1 property test is the STRUCTURAL guard)

- **Tier 1 — the equivalence PROPERTY test (the Structure-beats-Willpower guard).** For a matrix of
  session shapes — {protected, not-protected} × {standby (isAwakeMachine→false), awake
  (isAwakeMachine→true), isAwakeMachine UNSET} × {reapGuard returns null / open-commitment /
  recent-user-message / protected} — assert `computeIdleZombieReapVerdict(session).reasonKey`
  EQUALS the reason the REAL `terminateSessionInternal` stores for that same session.
  **The oracle MUST be the production `terminateSessionInternal` method itself** — construct a
  `SessionManager` whose DEPENDENCIES are fakes (reapGuard, `isAwakeMachine`, `protectedSessions`,
  and a session set up to trip the relevant gate) and read the real `result.skipped`. The test MUST
  NOT reimplement or hand-model the precedence — a modeled expected-reason would become a THIRD path
  that silently drifts from reality while the test stays green (reintroducing the exact anti-pattern
  the property test exists to kill). Because the oracle is the real method, any future terminate
  skip-reason addition or reorder flips `result.skipped` and FAILS this test — making the §3
  invariant a genuine machine check.
  **Matrix scope (per §3):** the EQUALITY assertion covers only the MIRRORED precedence reasons
  (`protected` / `not-lease-holder` / a reapGuard keep-reason / null). The DELIBERATELY-unmirrored
  transient residuals (`in-flight`, `already-<status>`) are NOT in the equality matrix — for those
  shapes the pre-check key intentionally differs from `result.skipped`, and they are covered instead
  by the flap-bound test below. (This resolves the "full-matrix equality vs residuals-not-mirrored"
  boundary explicitly.)
  **Completeness assertion (closes the "silent green on a NEW terminate gate" gap):** the matrix
  narrowing above means a NEW terminate skip-reason added BEFORE the lease gate, that no fixture
  trips, would leave CI green while re-desyncing the paths. To prevent that, the test also asserts a
  CLASSIFICATION COMPLETENESS invariant: every skip reason `terminateSessionInternal` can return on
  the idle-zombie path (enumerated from a single shared `IDLE_ZOMBIE_TERMINATE_SKIP_REASONS` const
  that the terminate path and the test BOTH reference) MUST be explicitly classified as either
  MIRRORED (in the equality matrix) or RESIDUAL (transient, covered by the flap test) — an
  unclassified reason FAILS the test. So a future gate cannot be added silently: it forces a
  classification decision, which is where a new mirror requirement surfaces.
  **Assert the COST, not just the symptom:** every multi-tick cell asserts the suppression of the
  actual work — the `terminateSessionInternal` ATTEMPT count and the reap-log-write (skip-record)
  count stay at their first-tick value across the cooldown window — NOT merely that one WARN fired.
  The WARN cadence was the visible symptom; the repeated terminate attempts + reap-log writes were
  the real cost, and they are what the cooldown must actually suppress.
- **Tier 1 — the repro (multi-tick hold, per "Distrust Temporary Success").** Standby machine
  (isAwakeMachine→false) + a session the reapGuard ALSO keeps (open-commitment). Drive MANY monitor
  ticks; assert exactly ONE WARN total and that `shouldRequest` returns false for the full 30-minute
  window across every tick (cooldown HOLDS). This test FAILS on today's code (spins) and PASSES with
  the fix.
- **Tier 1 — every precedence cell is MULTI-TICK (not single-tick key-equality):** protected+standby,
  standby-only, awake+keep-reason, protected+awake, and an `isAwakeMachine`-UNSET cell — each driven
  across many ticks asserting one WARN total + `shouldRequest` false for the window. Single-tick
  equality is a symptom check; the multi-tick hold is the root check.
- **Tier 1 — `in-flight` flap bound:** a tick sequence alternating an `in-flight` skip with an
  `open-commitment` keep asserts the entry is re-evaluated at most once per flap and does not sustain
  a per-tick WARN (bounds the named residual).
- **Tier 2 / Tier 3:** the enabled-path monitor tick over the HTTP/lifecycle surface stays green;
  the "feature is alive" E2E for the parent knob is unaffected.

## 5. Multi-machine posture

`machine-local-justification: hardware-bound-resource`

The `VetoedKillBackoff` ledger is a per-process in-memory Map, never persisted, never replicated —
each machine's `SessionManager` monitors ONLY its own live tmux/session set, and the veto-backoff is
a property of THIS machine's monitor loop against THIS machine's sessions (the resource it guards —
the local tmux session inventory — is hardware-bound). This fix only corrects WHICH reason KEY this
machine's own pre-check uses; it introduces no cross-machine surface, no replication, no merged read.
On a SINGLE-machine agent `isAwakeMachine()` returns true (awake), so the standby branch is skipped
and the method is byte-identical to today — a strict no-op. (Verified: the taxonomy key matches the
parent spec and is correct — the ledger is not a credential (rules out `physical-credential-locality`)
and not an operator waiver (rules out `operator-ratified-exception`).)

## 6. Config, rollback & migration

The change is confined to `computeIdleZombieReapVerdict` (one private method). Reverting the method
restores today's behavior. The parent config knob `monitoring.idleKillVetoBackoff.enabled` still
gates the WHOLE ledger — when `enabled !== true` the `handleIdleZombie` DISABLED branch bypasses the
pre-check entirely, so the corrected `reasonKey` is never consulted. **Migration Parity: N/A** — this
is a pure runtime code fix to one method; it changes no installed file (no `.claude/settings.json`,
no config default, no CLAUDE.md template, no hook script, no skill), so there is nothing for existing
agents to receive beyond the normal version bump.

## Frontloaded Decisions
- **FD-1 (fix approach):** option (a) mirror-precedence + the §4 equivalence property test (NOT (b)
  shared-helper — infeasible pure extraction; NOT (c) stale-reprieve change — wrong layer). Resolved.
- **FD-2 (precedence):** `protected` (via reapGuard) → standby `not-lease-holder` → reapGuard reason,
  exactly mirroring terminate. Resolved (the normative algorithm in §3).
- **FD-3 (residuals):** `in-flight`/`already-*` are accepted, bounded, non-recurring-by-construction;
  covered by the §4 flap test. Resolved.

## Open questions
*(none)*
