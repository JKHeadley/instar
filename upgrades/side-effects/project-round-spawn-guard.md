# Side-effects review — project round spawn guard

Change: `ProjectRoundExecution` resolves the autonomous binary via the existing
`detectClaudePath()` and handles the `'error'` event a failed spawn emits, recording a
round failure instead of crashing the agent server.

Related prior art: **ACT-1269** (2026-07-25, still pending) — same ENOENT class in the same
subsystem, different binary (`gh`). **CMT-513** (delivered 2026-05-25) — an uncaught
exception that crashed the whole server, i.e. the class has history.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**None identified, and the risk direction is checked.** The new branch fires only on a
`'error'` event from `spawn`, which is emitted exclusively when the child fails to START
(ENOENT, EACCES, EPERM). It cannot fire for a child that started and exited non-zero — that
path still runs the pre-existing resume logic, and a CONTROL test asserts it.

The binary resolution is `input.spawnCommand ?? detectClaudePath() ?? 'claude'`. An injected
`spawnCommand` (every test, and any future caller) is untouched, and the final fallback is
the previous literal, so a host where detection legitimately finds nothing behaves exactly
as before rather than failing earlier than it used to.

## 2. Under-block — what failure modes does this still miss?

**Named rather than glossed:**
- A child that starts successfully and then hangs forever is NOT covered here. The existing
  poll loop handles halt/set-change, but there is no wall-clock ceiling on a running child.
  Out of scope; not introduced by this change.
- A child that starts and immediately exits non-zero still consumes resume attempts, which
  is correct — that IS a "started and failed" case.
- ACT-1269's `gh` ENOENT is a DIFFERENT call site in a different layer and is **not** fixed
  here. This change does not close that action, and I am not claiming it does.

## 3. Level-of-abstraction fit

**Right layer, and I checked whether a higher one should own it.**
The obvious alternative was to add ENOENT to `uncaughtExceptionPolicy`'s survivable
allowlist. **Rejected on the module's own stated reasoning**: it crashes by default because
an unknown exception is not safe to swallow, keeps its list deliberately tight, and says in
place that it is *"the crash backstop, NOT a license to skip the catch — the first-seen-stack
logging still surfaces the un-guarded callsite so the real missing `.catch` gets fixed."*
Widening that allowlist would have degraded a deliberately-tight safety boundary to quiet one
callsite's bug. The policy is correct; the callsite was wrong.

Binary resolution likewise belongs in `Config.detectFrameworkBinary`, where it already lives
and is already used by five other files — not re-implemented here.

## 4. Signal vs authority compliance

Compliant. This adds no new blocking authority. It converts an unhandled process-level event
into a **recorded round outcome** — strictly more information, strictly less destructive. The
crash-vs-continue authority remains entirely with `uncaughtExceptionPolicy`, untouched.

## 5. Interactions — shadowing, double-fire, races

- **Two `'error'` listeners are attached deliberately** (one at the spawn site for the
  never-crash guarantee, one in the waiter for control flow). Node invokes all listeners; the
  first prevents the throw, the second drives the outcome. Not a double-fire: they have
  different jobs and the outcome is produced once.
- **An error that fires BEFORE the waiter attaches** is covered — the waiter checks the
  spawn-site capture first and returns immediately. Without that check there is a real
  ordering window.
- **No interaction with the halt path**: a halted round returns before the spawn-failure
  branch is reachable, and halt is checked first in the loop.
- **`killProcessGroup` is not called** on a spawn failure — correct, since there is no process
  group to kill; calling it would be a no-op at best.

## 6. External surfaces

**One, and it is operator-visible: the round's recorded `reason` string changes** for this
failure mode, from (previously) nothing at all — because the server died before writing — to
a sentence naming the spawn error.

Node's spawn error text already embeds the binary name (`spawn claude ENOENT`), so the reason
is diagnostic without plumbing the resolved absolute path through — which would risk leaking
an absolute home directory into an operator-facing record. That was a deliberate choice, made
after writing the interpolation and removing it.

No API shape change, no new config key, no new route. No CLAUDE.md update proposed: this adds
no capability an agent should newly reach for — it removes a crash.

*(Explicitly checked, because my own 07-30 review of a different change answered this section
"None. no external surface" and was wrong — a deploy path was an external surface. Here the
question was asked as "what else consumes this?" rather than "does the other tool read it?")*

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and the reason is intrinsic rather than an omission.** Binary
resolution answers "where is this program on THIS filesystem" — there is no coherent unified
value across machines, and a replicated answer would be actively wrong (the Mini resolves
`claude` under nvm; another host may use Homebrew or asdf). The existing
`detectFrameworkBinary` memo is per-process for the same reason.

The round outcome it produces is already per-project state written through
`InitiativeTracker`, whose replication posture this change does not alter.

## 8. Rollback cost

**Low, and the lever is real rather than assumed.** The change is two edits in one file plus
one import. Reverting the commit restores prior behaviour exactly; there is no migration, no
persisted new field, and no config key to unset.

A partial rollback is also available and safe: keeping the `'error'` handler while reverting
the resolution (or vice versa) leaves a coherent system, because the two halves are
independent — one prevents a crash, the other makes the launch more likely to succeed.

**Confidence stated honestly:** the crash and the hang are both reproduced by tests that fail
on the pre-change source, so the failure mode is verified rather than reasoned. What is NOT
verified is production behaviour on a host where detection returns a path that exists but is
not executable — the handler covers it by construction (EACCES is also an `'error'` event),
but no test exercises that specific errno.
