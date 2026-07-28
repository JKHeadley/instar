# ELI16 — Stop a dead peer's old lease from knocking the live machine offline

## The one-sentence version
When two machines share one agent, the active machine kept briefly flipping itself to "read-only standby" ~half the time — because a **2-day-expired lease from the other (standby) machine** was being treated as if it still counted. This fix says: an **expired or older** lease from a peer carries no authority, so it can never demote the machine that's actually in charge.

## How we got here (the live story)
Today we turned on multi-machine for real on the laptop + Mac mini pair. The laptop (the one with the public tunnel) became the "awake" leader; the mini became "standby." Good.

But then the laptop started **oscillating**: awake → standby → awake, roughly 50/50, every few seconds. While it was "standby" it went **read-only** and started **blocking real work** — saving job state, session bookkeeping — all failing with "StateManager is read-only." (It didn't crash, because an earlier safety net, #673, catches those. But the writes still failed.)

## The root cause (one picture)
Each machine's lease is like a **parking permit that expires every 60 seconds** and gets renewed on a timer. There are two independent loops:
- **tick** — renews our own permit and says "I'm awake."
- **pull** — looks at what peers are showing and, if a peer out-ranks us, steps us down to standby.

The bug was in **pull**. It stepped us down whenever it saw *any* peer permit at all — without checking whether that permit was **still valid** or **newer than ours**.

The mini was still showing a permit from **May 31, epoch 150** — expired two days ago, and far older than the laptop's live epoch ~1420. Every time the laptop's own permit lapsed for a split-second between renewals, the **pull** loop saw the mini's ancient permit and went "a peer has a permit, you must be out — step down." Then **tick** renewed and stepped it back up. Forever.

## The fix (tiny + precise)
A peer's lease may only demote us if it is **both**:
1. **Live** — not expired, and
2. **Strictly newer** — a higher epoch than our own.

A stale/expired or older peer permit is now ignored for the purpose of stepping down. The machine that's genuinely in charge stays in charge; its own brief permit-lapses are simply re-renewed by the **tick** loop (which is its job). Genuine takeovers — a peer with a *live, newer* lease — still demote us exactly as before. Same-epoch ties are still handled by the existing split-brain resolver, untouched.

Two small code changes:
- `LeaseCoordinator.peerLeaseSupersedes()` — the new "does this peer actually out-rank me?" check (live AND higher-epoch).
- `MultiMachineCoordinator.tickLeasePull()` — the pull loop now demotes only when `peerLeaseSupersedes()` is true.

## How we know it's fixed
A deterministic unit test (`LeaseCoordinator-stalePeerDemotion.test.ts`) reproduces the exact incident shape — a live holder observing an expired, lower-epoch peer, including the moment its own lease has just lapsed — and asserts it does **not** demote. It also checks the real takeover still works (a live, higher-epoch peer **does** demote). The existing convergence (#686) and split-brain-resolver tests still pass, so we didn't weaken the real failover.

## Why a unit test and not "watch the live machines"
We tried fixing it live first (clearing the stale lease, restarting) — it became whack-a-mole, because the stale lease keeps getting re-disclosed over the network and the observation is cached in memory. The unit test pins the behavior deterministically, the way #688 pinned convergence. The code change makes the live mesh robust regardless of caches or timing.
