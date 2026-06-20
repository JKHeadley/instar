# Side-Effects Review — B1 poll-ownership decision core (multimachine-lease-poll-robustness, Decisions 4/5/7)

**Change:** Add the pure poll-ownership decision (`decidePollAction`) — should this lifeline START / STOP / HOLD its Telegram poll, given the server-written lease intent, the operator override, observed peer poll state, a recent-409 flag, the debounce timer, and a failover signal. Asymmetric hysteresis: STOP immediate on lease loss; START guarded (never a 2nd poller; debounce a flap; immediate on genuine failover); stale/corrupt intent → HOLD (no surprise silence, no blind start); operator force-poll/force-mute is the local floor (Phase-0 pin survives as force-mute). Pure, deterministic, observe-only.

**Files:** `src/lifeline/pollDecision.ts` (new pure helper), `tests/unit/pollDecision.test.ts`.

**Rollout sequencing (deliberate, not deferral):** this commit lands the decision CORE — the riskiest part of B1 (the logic that prevents both double-handling AND silence) is now pure and exhaustively unit-tested in isolation. The cross-process PLUMBING that supplies its inputs and applies its action — the server writing `state/telegram-poll-intent.json` (PID/bootId/ts integrity, on every role transition incl. the 5s pull path), the lifeline `reconcilePolling()` loop on its 15s interval, `state/lifeline-poll-active.json` (the B5 guard's pollingActive source), the Phase-0 `telegramPolling`-pin migration, and the B5 `/guards` surface — lands in the next increment(s) behind `multiMachine.pollFollowsLease` (dev-gate, gated on B2+B5 live per Decision 12), with the partition fault-injection integration test the spec names + the full second-pass review for an ingress-critical change. Landing the decision first keeps each PR small and the highest-risk logic proven before it has a live ingress consumer. Tracked: spec Decisions 4–7/11/12 + CMT-1710.

## Phase 1 — Principle check (signal vs authority)
Pure decision function — no authority, no I/O, no consumer in this commit. When wired, its only "authority" is start/stop of THIS machine's own poll, and it fails toward HOLD on every uncertainty (stale intent, can't confirm peer state) — never a surprise stop, never a blind start. That is the signal-vs-authority-safe direction (silence > nothing; dual-poll is the harm it refuses).

## 1. Over-block / 2. Under-block
Gates nothing in this commit. Correctness axes (unit-tested): never start a 2nd poller (anotherMachinePolling / 409 → hold, even on a failover signal); never surprise-stop on a stale intent (→ hold); STOP is immediate on a real lease loss; failover starts immediately (no silence gap); a flap is ridden out by the debounce.

## 3. Level-of-abstraction fit
Right layer — a pure decision in `src/lifeline/` (where the poll loop lives), isolated from the file-I/O plumbing that will supply its inputs. Matches the B3/B4/B2/B5 pure-helper pattern.

## 4. Signal vs authority compliance
Compliant — pure function, no blocking authority. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
None in this commit (no consumer). When wired: reads the poll-intent file (B1 plumbing) + peer pollingActive (B5 source) + the local 409 signal; co-gated with B2 (flap breaker) + B5 (poller guard) per the spec's enforced rollout order so B1 can't ship ahead of its safety nets.

## 6. External surfaces
None in this commit (pure module). The live feature switches real Telegram ingress on/off — hence the deliberate decision-first sequencing and the full second-pass + partition integration test at wiring time.

## 7. Multi-machine posture (Cross-Machine Coherence)
The decision is per-machine (each lifeline decides its OWN poll), but it explicitly reasons about the POOL (peer poll state, failover) so two machines reach a single-poller outcome. The cross-process intent file is machine-local-by-design (each machine's own server↔lifeline). Single-machine: with no peer, `anotherMachinePolling`/`peerPresumedGone` are trivially false and the lease intent drives a clean single poller.

## 8. Rollback cost
Trivial — a pure module with no consumer; deleting it removes a tested helper. The live feature is dev-gated (`multiMachine.pollFollowsLease`) with a clean kill-switch returning the exact current static-flag behavior.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/pollDecision.test.ts` 12/12: STOP-immediate; standby/awake holds; no-2nd-poller (another polling / 409); failover-immediate-start; debounce-hold vs debounce-elapsed-start; stale-intent→hold (both directions); force-mute / force-poll floor; and the safety case (a failover signal does NOT override the no-2nd-poller gate).

## Phase 5 — Second-pass review
**Not required for this commit** — a PURE decision module with NO consumer and NO live authority (gates nothing, touches no session/lifeline/messaging path yet). The full second-pass (ingress-critical) runs on the wiring increment that connects it to the live poll loop. Declared `not-required` with this reasoning (consistent with B5's decision-core commit).
