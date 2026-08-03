# Side-Effects Review — Non-Lease-Holder Local Age Cleanup

**Version / slug:** `session-reaper-local-age-owner`
**Date:** `2026-08-02`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Heisenberg (item12_security_r1)`

## Summary of the change

`SessionManager` now gives its machine-local age monitor a runtime-private capability to terminate an
over-age, positively-idle session even when that machine does not hold the serving lease. The public
termination API does not accept the capability, and the authority validates both its unforgeable
identity and the literal `age-limit` reason. It also requires an installed KEEP guard and preflights
the exact StateManager session-write admission before touching tmux. `ReapLog` adds the optional `authorityScope` field so the
local exception is visible beside the already-recorded machine identity. The unified lifecycle spec,
plain-English overview, controller registry pointer, and production-path tests are updated together.

## Decision-point inventory

- `SessionManager` age-limit maintenance branch — **modify** — requests local cleanup through a
  runtime-private capability-minting entrypoint after existing age and positive-idle proof.
- `SessionManager.terminateSessionInternal()` lease gate — **modify** — admits only the runtime-private
  local-age capability after guard/write readiness while preserving lease refusal for every public
  autonomous request and normalizing forged public origin labels to autonomous.
- `SessionManager` process transition protocol — **modify** — isolates pre-kill observers, commits the
  terminal session row, and performs a SIGKILL-bounded synchronous tmux action with no intervening
  event-loop turn; every authority class refuses without a kill if final write admission changes.
- Post-transfer closeout wiring — **modify** — removes the public Boolean/reusable-closure lease bypass
  and replaces first-claim binding with a termination closure handed to the composition root only at
  manager construction; reaper dependencies become runtime-private and frozen.
- `StateManager` session-write admission — **modify** — exposes its exact non-mutating assertion so
  local cleanup cannot kill a process before learning the durable transition would be refused.
- Server startup — **modify** — starts session maintenance after ReapGuard and pool posture wiring.
- `SessionManager.terminateSessionInternal()` reap event — **modify** — stamps the admitting authority
  domain for durable observability.
- `ReapLog` write/read normalization — **modify** — persists a closed-enum optional authority scope.

---

## 1. Over-block

The intended authenticated operator-kill route still succeeds through the birth-bound termination
authority and therefore retains truthful process outcome plus reap-log coverage. The public
autonomous termination method no longer honors caller-minted `origin:'operator'` labels; that
was an authority-forgery hole exposed by the adversarial pass, not a supported contract. A public
autonomous age-limit request on a non-holder still returns `not-lease-holder`; only the production
monitor can mint the local capability. Existing protected and KEEP-guard refusals retain their exact
reason.

---

## 2. Under-block

The capability does not make an active session eligible. A false idle proof in the pre-existing
three-signal age gate remains the principal residual risk, bounded by the independent guard cascade
and the existing activity-aware tests. A pure standby or ownership-refused session cannot use this
path: the authority calls the same non-mutating write-admission assertion as `saveSession` before
touching tmux. The production active-active pool posture permits the eligible machine's exact
per-session write while shared-state writes remain blocked.

---

## 3. Level-of-abstraction fit

The change belongs in the single ReapAuthority rather than in tmux or the serving-lease coordinator.
The monitor produces the age/idle signal; the authority alone decides whether the kill may proceed.
A runtime-private capability expresses the local-process ownership fact without widening the public
caller contract or teaching the global lease about machine-local processes. The existing closeout
exception now uses the same structural rule instead of a caller-controlled Boolean.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but this is the existing deterministic ReapAuthority over an enumerable lifecycle domain.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Age and idle detection still have no kill authority. They feed the existing termination authority,
which holds the protected, lease, KEEP-guard, compare-and-set, in-flight, and self-action floors. The
new age capability is a hard provenance invariant: both JavaScript `#` authority methods are absent
from the runtime prototype, and its internal capability never crosses an overridable method. The
other trusted bypasses ride a termination closure delivered only during manager construction and held
in the server composition root's lexical scope. Public termination copies only inert fields and drops
unknown/cast bypass keys. A fabricated reaper therefore cannot acquire authority even if constructed
before the production reaper; the production reaper's terminate dependency cannot be swapped after
construction.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new competing-signals heuristic is introduced. Age and idleness remain governed by the existing
three-signal decision, and all live work signals remain vetoes. This change corrects an enumerable
authority-domain invariant: a local tmux process can be acted on only by its host machine, while
shared or remote state remains lease-holder-only.

---

## 5. Interactions

- **Shadowing:** The private capability bypasses only the lease-holder test. Protected-session and
  ReapGuard checks still run before any kill; CAS and in-flight checks still run afterward.
- **Double-fire:** The single-writer CAS remains the only termination chokepoint. A successful local
  reap clears the existing age backoff; no second actor can target the remote process.
- **Races:** A lease transition during the call does not widen authority. Each continuity observer
  runs independently while tmux is still inspectable; the terminal save then repeats ownership
  admission after those observers. Refusal returns `local-write-refused` (local/operator authority) or
  `state-write-refused` (ordinary autonomous authority), leaves durable state running, and leaves tmux
  alive. The successful commit is followed immediately by a synchronous tmux action bounded by the
  configured timeout and `SIGKILL`, with no event-loop turn between them. Maintenance does not start
  until guard and pool posture wiring have completed. A non-definitive tmux failure compensates the
  row back to its running snapshot and emits a named refusal with no success event; compensation
  failure has its own named refusal rather than being hidden. Post-kill lifecycle listeners are
  isolated per callback, so one observer cannot suppress a later durable reap-log listener.
- **Feedback loops:** Existing age-kill governor admission and `AgeKillBackoff` remain ahead of the
  capability mint. Sustained vetoes still settle under the registered convergence model.

---

## 6. External surfaces

The authenticated reap-log read may now include `authorityScope` on new reaped rows. The field is a
closed enum and contains no session content. Existing consumers tolerate its absence on legacy rows.
There are no new network calls, messages, configuration fields, URLs, databases, or operator actions.
Normal terminal-reap notification behavior is unchanged.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface is added or modified. The existing reap-log read gains one optional diagnostic
field; no dashboard, approval page, or form changes.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** The target resource is a tmux process plus its per-machine session file;
neither can be terminated by a peer. The serving lease continues to guard shared routing and every
ordinary autonomous termination. Production tests put the state tree into the real read-only standby
plus pool-active posture and prove only the session-scoped write lands. Both a first tick before guard
installation and a pure read-only/pool-inactive standby are refused before `beforeSessionKill` or tmux.

The reap-log is also machine-local by design and already stamps its machine identity. The new
`authorityScope` makes the local exception directly countable. The change emits no new user-facing
notice class, holds no new durable state, and generates no URL.

---

## 8. Rollback cost

Rollback is a normal code revert and patch release. New log rows may retain the optional
`authorityScope` field; older readers ignore unknown JSON fields. No migration, state repair, or user
action is required. Rolling back restores the zombie-retention defect on non-holders but does not
corrupt existing state.

---

## Conclusion

The implementation closes the contradictory authority boundary without broadening cross-machine
power. Multiple adversarial rounds exposed runtime-callable TypeScript privacy, startup/write-order
races, reusable or interceptable closeout authority, caller-forged origin authority, listener-driven
audit suppression, false-success state/process divergence, and an ignorable timeout signal. Each
demonstrated attack now has a structural repair and regression test. The final fresh adversarial
verdict explicitly concurs with no remaining concrete blocker in scope.

---

## Second-pass review (if required)

**Reviewer:** `Heisenberg (item12_security_r1)`
**Independent read of the artifact:** Intermediate rounds: **FAIL**, with concrete falsifiers. The
reviewer demonstrated that TypeScript-only privacy was runtime-callable; a pre-guard/pure-standby tick
could kill before durable write refusal; authority-scope labeling followed a caller flag;
reusable/captured or first-claim closeout authority could be forged; caller-supplied operator labels
crossed the lease/KEEP boundary; and a listener or tmux failure could leave process and state divergent
while claiming success. The final round also found that Node's default `SIGTERM` did not truly bound a
wedged synchronous tmux client. The correction uses JavaScript-private authority workflows, exact
write admission, late maintenance startup, birth-time authority handoff, public option whitelisting,
normalization, derived scope, per-listener isolation, a SIGKILL-bounded synchronous process action,
and kill-failure compensation. **Final verdict: PASS / explicit concurrence on the exact revision.**
The reviewer reported no remaining concrete authority-minting or state/process-divergence falsifier.
Independent verification passed TypeScript and 156/156 focused checks; the author's final broader
focused matrix passed 179/179, with lint and build also green.

---

## Evidence pointers

- `tests/unit/session-manager-terminate.test.ts` — production maintenance reproduction plus every
  authority/KEEP boundary, runtime privacy, startup-guard, pure-standby, and honest-scope regressions.
- `tests/unit/session-reaper-wiring.test.ts` — maintenance startup is structurally after guard and
  pool-write posture wiring.
- `tests/unit/session-timeout-activity-aware.test.ts` — age/idle proof remains required.
- `tests/unit/reap-log.test.ts` — authority-scope and machine-identity round trip.
- `tests/integration/session-lifecycle-reap-wiring.test.ts` — termination/reap-log lifecycle wiring.
- `tests/unit/self-action-convergence.test.ts` — registered age-kill controller settles under
  sustained rejection.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence:
{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts,
howCaught: the registered age-kill-backoff controller drives sustained rejection through a bounded
attempt horizon and proves the action count settles; the production-path regression separately proves
that a legitimate local cleanup now converges to one reap while protected/work vetoes converge to no
reap }`.
