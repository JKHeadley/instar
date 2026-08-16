---
name: promisebeacon-auto-pause
description: Shorter auto-pause horizon on inactive watchers—40 minutes instead of 2–3 hours
metadata:
  type: capability
  version: 0.28.83
  released: 2026-05-12
---

# PromiseBeacon Auto-Pause Tuning

When an agent commits to watching for something ("I'll let you know when X resolves"), it starts a heartbeat watcher that pings every ~10 minutes. Previously, the watcher kept pinging for about 2–3 hours of no progress before silencing. This felt like spam.

Now the default is much shorter: after about 40 minutes of unchanged status (4 heartbeats at default 10-minute cadence), the watcher sends one final message: "auto-paused — reply 'keep watching' to resume" and stops. If you reply "keep watching" on that topic, the watcher comes back for another round.

**What changed:**
- `PromiseBeacon` default for `defaultAutoPauseAfterUnchanged` lowered from 12 to 4 cycles
- Per-commitment overrides (via `beaconAutoPauseAfterUnchanged`) still work — they win against the default
- Resume path unchanged: reply "keep watching" and the watcher restarts

**What you'll notice:**
- Fewer auto-pause messages cluttering your timeline
- Same "keep watching" resume flow — no new commands to learn
- Watchers that genuinely need longer can still override per-topic (handled by the agent)

No configuration needed. Takes effect on next agent update.
