# Side-Effects Review — Standby persists pool-owned sessions (bug #9)

**Version / slug:** `standby-pool-session-writes`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`StateManager` gains a `_sessionPoolActive` flag (`setSessionPoolActive`) and a
`sessionScoped` option on the private `guardWrite`. A read-only standby now permits
`saveSession`/`removeSession` (per-session file writes) ONLY when the session pool is
active; all shared-cluster writes (`set`/`delete`/`saveJobState`/`appendEvent`) stay
blocked. `server.ts` sets `setSessionPoolActive(true)` where the SessionRouter is
wired. Closes bug #9 (the standby's owner-side resume was blocked at `saveSession`).

## Decision-point inventory

- **guardWrite** — read-only? no → allow. read-only + sessionScoped + poolActive →
  allow. else → throw. All three paths unit-tested.
- **saveSession / removeSession** — tagged `sessionScoped: true`. All other guarded
  writes unchanged (no opts → shared → blocked when read-only).
- **server wiring** — `setSessionPoolActive(true)` only in the SessionRouter-wired
  (pool-participant) block; default false elsewhere.

## 1. Over-block

**What legitimate inputs does this reject?** Nothing new is rejected. It RELAXES one
case: a read-only standby may now persist per-session state when the pool is on.
Shared writes are still rejected on a standby exactly as before. A non-pool agent is
unchanged (flag defaults false).

## 2. Under-block

**What does this still miss?** It does not address bug #7 (the standby has no
Telegram token → a moved session is mute). It scopes the exception to `saveSession`/
`removeSession`; if the owner-side resume later needs another per-session write, that
write would need the same tag (the next live re-test will surface it — same cascade
method). It does not add a pool-ownership re-check inside StateManager (the upstream
owner-side-resume path already gates on stage!=dark + CAS ownership; StateManager
trusts that, scoped to per-session files which cannot fork shared state).

## 3. Level-of-abstraction fit

**Right layer?** Yes. The guard lives in `StateManager.guardWrite` (the single write
chokepoint). The per-session vs shared distinction is expressed at each write's call
site via one boolean. The pool-participant signal is set once where the pool is
wired. No duplicated policy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This IS a safety-authority guard (read-only standby prevents state forks). The change
NARROWS the guard's scope for a provably-safe case (per-session owned files under
single-owner CAS), never widening it for shared state. It blocks nothing new and
adds no user-facing gate.

## 5. Interactions

The read-only flag is toggled dynamically by `MultiMachineCoordinator`
(`setReadOnly(!holdsLease)`); `_sessionPoolActive` is orthogonal (set once at pool
wiring). Together: a non-holder standby with the pool on may write owned sessions but
not shared state. The owner-side resume (`server.ts` onAccepted) is the consumer —
its `saveSession` now succeeds on the standby. Idempotent. No interaction with the
lease/registry shared-state path (still guarded).

## 6. External surfaces

None. No HTTP routes, config, or notifications. The visible effect is the absence of
the `owner-side resume failed … Blocked: saveSession` warning on a pool standby.

## 7. Rollback cost

Low. Revert restores the unconditional read-only block on saveSession (re-introducing
bug #9). No schema, no persisted state, no migration. The `_sessionPoolActive` flag is
in-memory only.

## Conclusion

Minimal, scoped relaxation of a safety guard for a provably-fork-safe case
(per-session owned writes under single-owner CAS), both sides + the one-awake-default
unit-tested, no shared-state exposure, no external surface, cheap revert. Lets a moved
session actually persist on the machine that now owns it.

## Second-pass review (if required)

Not required — narrowly-scoped guard relaxation, every decision branch + the
one-awake default tested, no shared-state write enabled, reversible, pool-gated. The
live two-machine re-test is the Tier-3 gate that follows.

## Evidence pointers

- `tests/unit/state-manager-readonly.test.ts` — read-only+pool-active allows
  saveSession/removeSession + persists; still blocks shared writes; read-only+pool-
  inactive blocks saveSession; normal machine writes all. Existing block tests green.
- 104 StateManager-family + coordinator + wiring tests green; `tsc --noEmit` clean.
- Found live on the mini: `owner-side resume failed for topic 8882: StateManager is
  read-only (this machine is on standby). Blocked: saveSession`.
- Spec: `docs/specs/standby-pool-session-writes.md` (+ `.eli16.md`).
