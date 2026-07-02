---
title: "U4.4 — Lease Hand-Back to the Preferred Captain (hysteresis-gated, never flapping)"
slug: "u4-4-lease-handback"
author: "echo"
status: "draft"
parent-principle: "Verify the State, Not Its Symbol — the long-term lease holder should reflect the intended captain, not wherever a failover left it"
sibling-principles: "Bounded Blast Radius; The Agent Is Always Reachable; Runtime End-to-End Proof"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md (soloCaptainHold); MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "fenced serving lease; lifeline drift-promoter clean-window logic (reused); multiMachine.meshTransport reachability"
---

# U4.4 — Lease Hand-Back to the Preferred Captain

## 1. Problem

After a failover moves the serving lease off the preferred (stationary) captain to a
standby, the lease does NOT automatically hand BACK when the preferred captain
recovers — it stays on the standby until the next disruption. On the operator's
asymmetric setup (an always-on Mac Mini + a frequently-asleep Laptop), the mesh drifts
to the WRONG long-term holder: e.g. serving ends up stuck on the Laptop (which then
sleeps, forcing another failover) when the Mini is the intended stable captain. The
`mesh-captain-flip-playbook` memory documents this as a MANUAL bounce — exactly the
kind of manual intervention this project exists to eliminate.

## 2. Design

**A preference-weighted, HYSTERESIS-gated automatic hand-back at a clean boundary.**

- **Preferred holder:** the lease records an optional `preferredHolder` (a machineId,
  operator-configured — defaults to unset = today's sticky "whoever holds it keeps
  it" behavior). On the operator's setup this is the Mini.
- **Hysteresis (the anti-flap heart):** hand-back fires ONLY when the preferred
  captain has been CONTINUOUSLY healthy (reachable across ≥1 transport, lease-eligible,
  quota-OK) for a SUSTAINED window (default ~10 min) — NOT on first recovery. A
  preferred captain that is flapping (sleeping/waking repeatedly) never triggers a
  hand-back, because it never stays healthy long enough. This is the same
  sustained-clear shape U1's notice decay and U4.5's rope alerts use — reuse it.
- **Clean-boundary hand-back:** when the hysteresis window is satisfied, the hand-back
  runs at a CLEAN boundary — no in-flight message forwards, no queued messages, no
  recent ingress in the last ~90s — mirroring the existing lifeline drift-promoter's
  clean-window logic. It is a graceful, fenced lease transfer (the standby releases,
  the preferred captain claims with a bumped fence), NOT a kill. Active work is never
  interrupted; a busy standby simply defers the hand-back until it's idle.
- **Never fights soloCaptainHold:** if the preferred captain is provably GONE, the
  standby legitimately holds (that's `soloCaptainHold`, already dark/opt-in in the
  multi-transport spec). Hand-back only pulls the lease TOWARD a HEALTHY preferred
  captain — the two compose (hold when preferred is gone; hand back when it returns
  and stays healthy).

## 3. Multi-machine posture (mandatory)

Inherently multi-machine. `preferredHolder` is part of the replicated lease state, so
every machine agrees who the preferred captain is. The hand-back decision is made by
the CURRENT holder (it initiates the graceful release toward the preferred captain
once the hysteresis + clean-boundary conditions hold, judged against its own live
reachability of the preferred captain). Single-machine install = strict no-op (the
sole machine is always both holder and — if set — preferred). No new attention surface;
a hand-back is a routine lease transfer logged in the existing lease audit.

## 4. Tests

- `handback-fires-after-sustained-preferred-health` (and does NOT fire before the
  window elapses).
- `flapping-preferred-captain-never-triggers-handback` (the anti-flap core: repeated
  wake/sleep inside the window resets it).
- `handback-waits-for-clean-boundary` (in-flight forward / recent ingress defers it).
- `handback-never-interrupts-active-work`.
- `no-preferredHolder-set-is-sticky-todays-behavior` (default off).
- `handback-and-soloCaptainHold-compose` (hold when preferred gone; hand back when it
  returns healthy).
- Single-machine: `no-op`.

## 5. Rollback / rollout

Ships dark → dry-run (logs "would hand back to <preferred> at clean boundary" without
moving the lease) → dev-agent → fleet, gated by
`multiMachine.meshTransport.leaseSelfHeal.preferredCaptainHandback` (sibling of the
already-dark `soloCaptainHold`). Rollback = drop the flag / unset `preferredHolder`;
the lease reverts to sticky. Reuses the fenced lease + drift-promoter clean-window —
no new transfer machinery.

## Frontloaded Decisions

1. **Hysteresis, not first-recovery** — an asleep-prone Laptop must never trigger a
   hand-back storm; sustained health is the gate.
2. **Clean boundary, graceful transfer, never a kill** — active work is sacrosanct.
3. **Default unset = today's sticky behavior** — opt-in per operator setup; the
   asymmetric always-on-Mini setup is the motivating case, not a universal default.
4. **Composes with soloCaptainHold** — hold when preferred is gone; hand back when it
   returns and stays healthy. (Contested-cheap: N/A — the lease is real serving
   authority; ships dark + dry-run first.)

## Open questions

None.

> The hysteresis window and clean-boundary quiet-period are config knobs with defaults
> (~10 min health, ~90s quiet) aligned to the drift-promoter — frontloaded config.
