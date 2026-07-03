---
kind: "spec"
id: "mesh-self-heal-graduation"
title: "Mesh Self-Heal Graduation"
summary: "Operationalize multi-machine self-healing: move U4.2/U4.4 (stale-owner release + lease hand-back) and the liveness-reconciler from dark into production."
---

# Mesh Self-Heal Graduation

**Status:** DRAFT
**Owner:** Echo  
**Created:** 2026-07-03  
**Goal Alignment:** Goal B (Seamless agent across machines), M5 (session-respawn fix)

## Problem

Multi-machine failover is currently **reactive + manual**:
- If Laptop (lease-holder) goes silent, Mini cannot take over conversations automatically
- Lease-tick flapping means frequent avoidable restarts
- Liveness reconciliation (detecting dead sessions and respawning them) is dark + not production-ready
- **Zombie machines** can hold leases even when unreachable (the 2026-06-19 incident)

M5 (session-respawn elimination) depends on self-healing to work: if a session dies due to an infra blip, self-healing must revive it WITHOUT a full respawn cycle.

## Design

### Layer 1: Stale-Owner Release (U4.2 — already shipped dark)

**Problem it solves:** Laptop goes offline but its heartbeat process dies too slowly. Mini can't claim conversations because Laptop's lease is still "valid."

**Solution:** Force-claim conversations from a provably-dead machine by verifying:
1. The machine's heartbeat has STOPPED (>5m no update)
2. The machine is UNREACHABLE on every transport (Tailscale + LAN + Cloudflare)
3. There are no active jobs/processes on the machine (via QuotaTracker)

Then Mini reclaims Laptop's topics with a claim record and a one-time offer to Laptop to take them back if it recovers.

**Graduation:** Enable U4.2 and log all force-claims to `logs/stale-owner-release.jsonl`. Monitor false positives for 1 week. Graduate to dry-run → live.

### Layer 2: Lease Hand-Back (U4.4 — already shipped dark)

**Problem it solves:** After Laptop recovers, conversations are still on Mini. Mini keeps serving them even though Laptop is the "preferred" captain.

**Solution:** After Laptop is healthy again (heartbeat active + reachable on 2+ transports for 10m), Mini **hands back** the lease to Laptop with a single-use, signed consent token. Laptop accepts and resumes its topics.

**Graduation:** Same as U4.2 — enable, observe, verify no thrashing.

### Layer 3: Liveness Reconciler (autonomous-liveness-reconciler)

**Problem it solves:** A session is marked ACTIVE in the autonomous-run state file, but no tmux process exists to run it (crashed, killed, orphaned). The run just... hangs.

**Solution:** Background reconciler (2m cadence) scans all active autonomous runs:
- For each run, check: does a live tmux session exist?
- If NO: has the run expired? If no, respawn it.
- If YES: is it actually working? (check for output changes). If stuck, nudge it.

Audited to `logs/autonomous-liveness.jsonl`.

**Graduation:** Already partially implemented; needs:
- Dead-session detection (tmux check)
- Respawn trigger (existing resume-queue logic)
- Quota + breaker gating (avoid thrashing)
- Live-verification (test on the real pair with intentional kills)

### Layer 4: Lease-Tick Flap Fix

**Root cause (M1 finding):** The lease-tick ran but occasionally was slow, so the watchdog thought it stalled and re-armed it. This caused brief election chaos.

**Fix:** 
- Increase lease-tick timeout (currently 2s, try 5s)
- Log every tick result (latency, decision)
- Measure flap rate: `GET /health → multiMachine.syncStatus.leaseFlaps` (count + rate)
- When flap rate > threshold, escalate (log + attention item, never auto-act)

## Implementation Strategy

### Phase 1: U4.2 + U4.4 Graduated to Live
- Flip `multiMachine.staleOwnerRelease.enabled: true` and `leasHandback.enabled: true`
- Monitor for 1 week: watch `/pool/stale-owner-release` and `/pool/lease-handback` for anomalies
- No frequent re-claims = success

### Phase 2: Liveness Reconciler Wiring
- Implement dead-session detection (tmux exists check)
- Wire respawn trigger to resume-queue
- Add quota + breaker guards
- Dry-run for 1 week

### Phase 3: Lease-Tick Tuning
- Increase timeout, measure flap rate
- Log every tick decision to `logs/lease-tick.jsonl`
- Verify flap rate drops

### Phase 4: Live-Verify Failover Scenario
- **Scenario A:** Laptop is lease-holder. Kill Laptop's processes (simulating a crash).
  - Expect: Mini detects dead Laptop, force-claims conversations, serves transparently
  - Verify: No topic-orphans, no double-serving
  
- **Scenario B:** Laptop recovers. Health checks confirm it's alive.
  - Expect: Mini hands back lease to Laptop, Laptop resumes its topics
  - Verify: Smooth hand-back, no thrashing

- **Scenario C:** Autonomous run on Laptop. Kill the tmux session.
  - Expect: Liveness reconciler detects dead session, respawns it
  - Verify: Run resumes without manual intervention

## Test Plan

**Tier 1 (Unit):**
- Stale detection: is-machine-dead logic
- Hand-back: consent token generation + validation
- Liveness check: tmux process detection

**Tier 2 (Integration):**
- State-read correctly reflects machine status
- Lease operations succeed (claim + hand-back)
- Respawn trigger fires when needed

**Tier 3 (E2E):**
- Intentional machine kill on the real pair
- Verify failover is smooth + transparent
- Verify hand-back happens when machine recovers
- Verify no session orphans or double-serving

## Success Criteria

- [ ] U4.2 + U4.4 enabled in production, flap-free for 1 week
- [ ] Lease-tick flap rate < 1% (currently ~5%)
- [ ] Liveness reconciler detects + respawns dead autonomous sessions
- [ ] Failover scenario tested on real pair: Laptop kill → Mini takeover → Laptop recovery → hand-back
- [ ] Zero topic orphans or double-serving
- [ ] Session-respawn count drops measurably (M5 dependency)

## Failure Modes

- **Thrashing:** U4.2 keeps claiming the same topics from Laptop. Mitigated by: cooldown + one-time hand-back offer.
- **Split-brain:** Both machines think they hold the lease. Mitigated by: numbered epochs + quorum requirement.
- **Zombie respawn loop:** Liveness reconciler keeps respawning a broken session. Mitigated by: breaker + max-respawn-cap.

---

**Related specs:** intelligent-working-set-lazy-sync, session-respawn-thrash-elimination
