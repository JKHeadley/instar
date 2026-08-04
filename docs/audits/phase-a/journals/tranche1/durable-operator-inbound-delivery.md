# L2 / Tranche 1 / durable-operator-inbound-delivery

**Guard:** `multiMachine.sessionPool.inboundQueue.enabled`
**Critical path (from the guard's own declaration):** *operator inbound message delivery (durable custody
+ drain for undeliverable inbound messages)*
**Why Tranche 1:** load-bearing AND not `on-confirmed` — the "looks protected, never exercised" class.
**Measured:** 2026-08-04 06:12–06:14Z, both machines.
**Status:** DERIVED from the evidence below — not asserted, not cached.

---

## VERDICT — per machine (architect amendment, 2026-08-04)

| rung | Mini | Laptop |
|---|---|---|
| **exists** | ✅ `inboundQueueConfig` on disk, referenced by `MachinePoolRegistry` | ✅ same package |
| **wired** | ✅ route answers, constructed, `enabled: true` | ✅ route answers, constructed, `enabled: true` |
| **effective** | ❌ **`dryRun: true`** — cannot take custody by construction | ❌ **live but never exercised** |

**`machines_on_critical_path: [mini, laptop]`** — operator inbound arrives on both.

> ## `aligned: FALSE`
> Per the amendment, `aligned` is true only if `effective` passes on **every** machine the critical path
> runs on. It passes on neither.

---

## ⭐ THE FINDING — the same guard is materially different on each machine

| | Mini | Laptop |
|---|---|---|
| `configEnabled` | **true** | **true** |
| `dryRun` | **TRUE** | **FALSE** |
| guard `effective` | `on-dry-run` | `on-unverified` |

**Both machines report the guard as enabled. Only the laptop actually takes custody.** On the Mini it
observes and does nothing — so an operator message that cannot be delivered is **not durably held there**,
which is precisely the loss this guard exists to prevent.

**This is exactly what the architect's amendment was added to catch**, and it surfaced on the very first
node. A single fleet-wide verdict would have recorded "enabled, load-bearing, dry-run" or "enabled,
live" depending on which machine happened to be measured — and either would have been wrong about the
other.

## Rung 3 could not be attempted, and that is itself the verdict

The contract's rung 3 requires an **injected violation caught on current code**: make a message
undeliverable and verify it is durably held and re-delivered.

- **Mini:** the test is *structurally impossible to pass* — `dryRun: true` means the queue observes and
  never takes custody. **A dry-run guard cannot bite. `effective: false` is not a measurement failure
  here; it is the measurement.**
- **Laptop:** live, so the test is *possible* — but `runtime: null` / `on-unverified` means nothing
  observes whether it fires, and the counters show **`queued: 0, held: 0, delivered24h: 0`**. It has
  **never taken custody of anything.** Recording `effective: false` on "live but never exercised" rather
  than assuming a live flag implies a working guard — that assumption is the exact error this phase exists
  to eliminate.

⚠️ **Not attempted deliberately:** injecting a genuine undeliverable operator message would risk the real
operator-message path on a live machine. That is an authority I do not hold unilaterally. **The safe form
of this test needs a throwaway agent + demo channel** (per the Live-User-Channel Proof standard) and is
the node's first follow-up, not a silent omission.

## Exit condition (unchanged, restated)

A three-rung verdict per machine with source + timestamp, where rung 3 is decided by an injected violation
on current code. **Currently met for rungs 1–2 on both machines; rung 3 is `unmeasured-by-injection` on
the laptop and `structurally-impossible` on the Mini until dry-run is lifted.**

## What would move this to `aligned: true`

1. Lift `dryRun` on the Mini (an operator decision — it is a rollout stage, not a defect).
2. Instrument the guard so it reports a runtime tick (it is one of the 64 with no heartbeat).
3. Run the injected-violation test on a throwaway agent + demo channel on **both** machines.

## Surprises

- **The divergence itself.** I expected a dark-everywhere or live-everywhere posture. Finding the *same
  guard* in different actuation states on two machines of *one agent* is the strongest single argument
  for the amendment, and it appeared on node 1 of 68.
- **`delivered24h: 0` on the machine where it IS live.** The laptop's queue has been armed and has never
  held a message. So "live" and "proven" are separated by an unmeasured gap even on the good machine —
  which is the whole thesis of Tranche 1 restated as data.


---

## CORRECTION 2026-08-04 10:49Z — the "never exercised" verdict was WRONG

At 06:12Z I read this route's `counts` block and concluded *"live but never exercised … it has never
taken custody of anything."* **I never printed the sibling `counters` block on the same response.**

```
counts:    queued 0 · held 0 · delivered24h 0
counters:  wouldEnqueue 4 · wouldHold 2 · wouldRefuse 3      <- NINE real opportunities
           holdsStarted 4 · holdsRecoveredInPlace 4          <- the hold sub-policy DID act
```

**Corrected verdict: `effective: FALSE — EVIDENCED` (not "unmeasured").** The guard has had **nine
genuine opportunities and took none**, because `dryRun: true` by construction. **Four inbound messages
were not durably held when this queue would have held them.**

**And the node needs splitting:** the **hold sub-policy is LIVE and acting** (4 holds started, 4
recovered in place) while the **queue itself is dry-run**. One `effective:` verdict for the whole node is
wrong about one half whichever way it lands — the same per-machine lesson the architect's amendment
taught, now recurring per-SUB-FEATURE.

**This wrong verdict stood for 4h37m on the audit's very first node.**
