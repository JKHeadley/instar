# Side-Effects Review — Post-transfer session closeout

**Version / slug:** `post-transfer-session-closeout`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (kill-path change, but every kill goes through the existing terminate authority; every boundary side test-pinned; inert single-machine)

## Summary of the change

Two halves closing the operator-named duplicate-sessions gap: (A) the transfer
handler immediately closes the local topic session when the user explicitly
moves a topic to another machine (operator origin, protected-skipped, silent
recovery-bounce disposition); (B) a SessionReaper rule closes any topic-bound
session whose topic the ownership registry shows OWNED BY ANOTHER MACHINE,
after a 2-tick dwell, through the guarded autonomous terminate (vetoes audited
+ retried). New `topicOwnerElsewhere` reaper dep late-binds the pool objects;
config `monitoring.sessionReaper.topicMovedCloseout` (default true) +
`topicMovedConfirmTicks` (default 2).

## Decision-point inventory

1. Plan is `transfer` to another machine vs `noop`/self → immediate close vs
   none. Covered by the rule conditions + transfer tests from #790 (noop paths
   unchanged).
2. Session protected → immediate close skipped (and the sweeper's guard veto
   path). Pinned via reaper-family protected test + the explicit skip.
3. Topic owned elsewhere vs by-self vs unowned vs no binding vs dep absent →
   sweeper fires vs inert. All five pinned.
4. Dwell below/at threshold; churn reset. Pinned.
5. killsEnabled (enabled/dryRun/auto-disabled) → terminate vs `would-reap`
   audit. Pinned.
6. Guard veto → `reap-skipped-topic-moved` + retry. Pinned.
7. Per-tick + hourly budgets. Pinned (per-tick), hourly shares the existing
   tested budget mechanism.

## 1. Over-block

The rule only ever closes MORE sessions, never keeps one it shouldn't — the
risk axis is over-KILLING, addressed in Under-block. No legitimate
operation is rejected; single-machine installs are bit-identical in behavior
(dep absent → rule unreachable).

## 2. Under-block (over-kill risk — the one that matters)

- **Wrong-owner false positive:** the ownership registry is the same source
  routing already trusts; a 2-tick dwell absorbs CAS churn mid-transfer, and
  churn RESETS the dwell (test-pinned). Worst case (registry wrong for >2
  ticks): the session closes while the registry routes messages to the other
  machine anyway — the close follows the routing truth, not vice versa.
- **In-flight work on the duplicate:** deliberately closable — duplicate work
  is the bug (operator's words). The sweeper still honors KEEP-guard vetoes
  (retry, not force); the immediate half is the user's explicit command.
- **Protected sessions:** never auto-closed on either half.
- **Half A races the release CAS:** the close is fired after the release
  attempt regardless of CAS outcome — but only when `plan.action ===
  'transfer'`, which already passed the planner's owner/pin checks; a failed
  CAS still means the user commanded the move, and the pin routes the next
  message away from this machine.

## 3. Level-of-abstraction fit

The immediate half lives in the one handler that executes user moves; the
invariant lives in the reaper — the component whose job is "sessions that
should not be running, aren't" — via an injected signal, keeping
SessionReaper free of pool imports (fully unit-testable, same pattern as
every other dep). The terminate authority remains the single kill funnel.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The sweeper REQUESTS kills through the guarded authority (autonomous origin —
vetoes win). The immediate half uses operator origin, which is the documented
user-command bypass; the terminateSession doc comment is updated to name this
second stamp site, and protected sessions are excluded before the call so the
bypass never reaches them on this path.

## 5. Interactions

- ReapGuard/ReapAuthority untouched — same funnel, same vetoes.
- Reap-log + §P3 notifier: sweeper closes are `terminal` (one honest "session
  was shut down — topic moved to X" notice via the existing reapNotify);
  Half A is `recovery-bounce` (silent — the user just got "Moving…").
- Ownership registry is read-only here (ownerOf) — no new writers.
- The dep's try/catch absorbs the construction-order TDZ window (reaper is
  built before the mesh block wires the registry) — rule inert until wired.

## 6. External surfaces

Two config keys (defaults preserve behavior except the new closeout itself,
which is the fix). New audit rows (`rule: 'topic-moved-away'`,
`reap-skipped-topic-moved`). CLAUDE.md template line + idempotent append
migration. No routes, no schema.

## 7. Rollback cost

`monitoring.sessionReaper.topicMovedCloseout: false` is an instant per-agent
off-switch; full revert restores the old lingering behavior. No state.

## Conclusion

The operator-named duplicate-session bug closed at both speeds — instantly on
the explicit command, eventually-but-guaranteed everywhere else — without a
single new kill path outside the existing authority.

## Second-pass review (if required)

Not required — see header.

## Evidence pointers

- `tests/unit/session-reaper-topic-moved.test.ts` (9) — incl. the headline
  "closes a BUSY duplicate" case.
- `tests/unit/PostUpdateMigrator-poolSessionsVisibility.test.ts` (+3).
- Reaper family regression 65/65 green; tsc clean.
- `docs/specs/post-transfer-session-closeout.md` + `.eli16.md`.
