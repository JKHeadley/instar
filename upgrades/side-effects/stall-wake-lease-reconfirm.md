# Side-Effects Review — a machine back from a stall re-asks before it takes the lead

**Version / slug:** `stall-wake-lease-reconfirm`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Fixes fb-fdb55c1c-a79: after a long main-thread stall or sleep, a standby claimed the lead on a lease that only looked
expired because it had not been running (Laptop over a healthy Studio, 16:09:48Z and again 08:30:23 PST, 2026-11-21).
New pure module `src/core/StallReconfirm.ts`; `LeaseCoordinator` gains an awake clock (2 s unref'd timer plus stamps at
acquire and pull entry), a stall episode opened when lost running time inside one TTL exceeds 30 % of the TTL, and a
gate in `acquireIfEligible` (after `canAcquire` and the boot-hold block) that, while an episode is open, holds any claim
until one TTL passes awake and a pull round started after the stall has completed (or a ten-TTL chain cap of monotonic
time, which also needs that completed round). It makes one fresh pull per episode
first, so a live holder's renewal folds and `canAcquire` refuses. Config type in `src/core/types.ts`, live wiring in
`src/commands/server.ts`, awareness entry, release fragment, spec + ELI16. Tier 2 (lease safety decision); dark switch
`multiMachine.takeoverReadyPool.stallReconfirm.enabled` (explicit true only). Size: about 280 LOC in src, 4 test files.
Effort: 6 spec review rounds, the Tier-2 cap (every round surfaced real design findings; the last one was resolved by
removing the probe-based silence rule, which narrowed the design to its smallest sound form).

## Decision-point inventory

- `LeaseCoordinator.acquireIfEligible` claim path — modify (add a hold, never a grant) — while a stall episode is open, every claim waits for C (one TTL awake + a completed post-stall round) or the chain cap, after at most one fresh pull.
- `LeaseCoordinator` renew, consent, hand-back, decommission paths — pass-through (unchanged).
- R1 boot hold (`evaluateBootHold`) — pass-through (its ask runs first; the extra pull is skipped when it ran).

---

## 1. Over-block

A false episode (an NTP forward step, or heavy load losing more than 18 s in a minute) delays a legitimate takeover of
a dead holder by up to one TTL awake. After any real stall a dead holder is taken over one TTL (60 s) after the wake,
not at once. A former holder reclaiming its own lapsed lead after its own stall waits one TTL awake. A starving machine
that keeps re-opening episodes withholds its takeover for at most ten TTLs of monotonic time (chain cap), provided it
completes one pull round after its latest loss. All bounded; none blocks a takeover forever.

## 2. Under-block

- C after one TTL awake is today's rule on an awake clock: a one-way partition where the holder's pushes and pull
  replies both fail still ends in a claim, exactly as today (the parent spec's accepted R2 risk).
- Losses in gaps under 6 s are not counted; safe while the loop still folds between them.
- A backward wall-clock step inside an open episode makes no round count as fresh until the wall clock catches up
  (round starts and episode times are wall-clock), so a dead holder's takeover, including the chain cap, waits about
  the size of the step: safe side, bounded, and listed in the spec's failure modes.
- The holder side is unchanged (a holder that slept past a TTL relies on existing fencing): filed as fb-54f9ae11-2ca.

---

## 3. Level-of-abstraction fit

Right layer: the lease coordinator is the one lease actor and already owns the ask-first logic (R1); the gate sits in
the same loop and reuses only `pullWithin` and `pullFromPeers` (nothing reads a probe). SleepWakeDetector was not used
as the trigger because it suppressed the 226 s drift without emitting anything; the coordinator measures its own lost
time, which covers every ordering of overdue timers at wake.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface beyond withholding a claim the normal fenced-lease rules would
  make. It can never grant a claim they would refuse, and every hold is bounded (C, chain cap). The thresholds are
  derived from the lease's own cadences (renew TTL/2, pull 5 s, stamp 2 s), not brittle content matching.

## 4b. Judgment-point check

The new static thresholds are declared in the spec's `## Decision points touched` with basis and evidence (30 % of TTL
from the renewal and pull cadences; 6 s from the stamp cadence; one TTL from today's own expiry rule); the chain cap is
a judgment-candidate with a floor. No competing-signals point
gets a new static heuristic without that declaration.

---

## 5. Interactions

- **Shadowing:** runs after `canAcquire` and after the boot-hold block; a live holder is refused by `canAcquire` before
  the gate, so the gate only ever sees claims the normal rules allow. Nothing reads a probe, so #3604's probe `cause`
  field neither helps nor conflicts. The boot-hold ask and the gate's pull never stack
  in one call (the gate skips its pull when the boot-hold ask ran).
- **Double-fire:** the gate's one fresh pull and the 5 s pull loop can overlap once; `pullAllPeers` is idempotent and
  the transport already tolerates concurrent rounds.
- **Races:** the awake stamp is written by the timer, acquire and pull entries, all on one thread. A CAS loss keeps the
  episode open, so the retry is judged again. The episode closes only when an allowed claim lands or it ages out (on a
  live view only).
- **PR #3604:** this diff applies cleanly onto #3604's branch (`git apply --cached --3way --check` against
  origin/fix/planned-restart-keeps-lead, re-run on the final diff). Silence is never read as death here, so #3604's
  rule that a silence this machine caused is unknown is honoured trivially.

## 6. External surfaces

No new route, notice, file or message. New log lines (`stall-reconfirm: ...`) and feature-evidence rows on the existing
`multiMachine.takeoverReadyPool` ladder entry (`held`, `fired`, two `error` reasons). No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

The rule runs on each machine's own claims; its evidence arrives over the existing lease channel. The awake stamp,
lost-time samples and episode are machine-local by design (this process's own running time, in memory only, never
persisted). No notices, no durable state, no URLs. No status surface changed.

## 8. Rollback cost

Config: `enabled: false` (or `takeoverReadyPool.enabled: false`), read live, no restart; the timer clears itself at its
next tick. Code revert: one module, one coordinator block, one dependency line, one type. Nothing persisted, no
migration, no user-visible regression during rollback.

---

## Conclusion

The review reshaped the design every round (reply shortcut removed; threshold re-derived on whole gaps; C needs a
round started after the stall and completed, on awake time only; own-lapse, released and empty views gated; chain cap
on monotonic time; aged-out episodes only on a live view; at most one extra pull per episode; and finally the
probe-silence rule removed because a probe cannot prove its dial started after the stall). Clear to ship dark; the run lead enables it on the Echo pool.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact:** concern

Concern raised (round 1 of the second pass): the safety logic is sound, but two documentation inaccuracies need fixing and one clock edge is worth closing. Checked and agreed: the gate only adds `return false` or a pull followed by `continue` back through `canAcquire`, so it can never let through a claim that today's code refuses. Every pull dials afresh (`HttpLeaseTransport.pullAllPeers` has no shared in-flight promise), so a round that started before the stall can never count as fresh. A live holder's renewal folds before rule C can be met. A dead holder is still taken over about one TTL after the wake, because the 5 s pull tick re-runs `tickLease` through `peerTakeoverEligible`. With the switch off, every new branch returns null. With the switch on and no gap, no episode ever opens. Renew, consent, decommission and contested-win are untouched. The two unit files pass (27/27).
1. `src/core/types.ts`, the `stallReconfirm` doc comment, still describes the rejected rule: "the holder silent by R1's test while another peer answers". Fix: say "a full TTL awake with a pull round started after the gap and completed, or the ten-TTL chain cap".
2. The artifact's §3 says the gate "reuses `pullWithin`, `classifyPeer` and the transport's probe history". The final code reads neither `classifyPeer` nor any probe. Fix: say it reuses only `pullWithin` and `pullFromPeers` (§5 already says "Nothing reads a probe").
3. (Minor, safe-side.) `freshRoundCompletedSinceStall` compares wall-clock round-start times with the wall-clock `openedAtMs`/`lastLostAtMs`. After a backward wall step inside an open episode, no round counts as fresh until the wall clock catches up. That also blocks the chain cap, which requires a fresh round, so takeover of a dead holder is withheld for about the size of the step. Fix: stamp the round start and the episode open/loss times on `monotonicNow()` and compare on that clock, or note this bound in §1.

**Resolution (author):** 1 fixed in `src/core/types.ts`; 2 fixed in §3; 3 noted in §2 (under-block) as the safe-side
bound, already a row in the spec's failure modes.

**Re-check (second-pass reviewer):** concur. All three spots now match the code; the wall-step note describes a delayed takeover, so it reads more naturally under §1 (over-block) than §2, but it is accurate and bounded where it stands.

---

## Evidence pointers

- Unit: `tests/unit/StallReconfirm.test.ts`, `tests/unit/LeaseCoordinator-stallReconfirm.test.ts` (switch off reproduces
  the 23761 claim; switch on holds and re-confirms the Studio).
- Integration (real HTTP): `tests/integration/stall-wake-lease-reconfirm.test.ts`.
- E2E (real `initializeLease` + `tickLease`): `tests/e2e/stall-wake-lease-reconfirm-boot-path.test.ts`.
- Adjacent: `LeaseCoordinator-bootClaimSafety`, `boot-claim-safety` (integration), `boot-claim-safety-boot-path` (e2e).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller in the `unbounded-self-action` class: the change
adds a timer that only records time, and a single bounded pull per episode; it fires no restart, swap, respawn,
spawn, notify, retry loop or kill. Not applicable.
