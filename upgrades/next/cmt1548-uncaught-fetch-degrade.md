## What Changed

Fixed a robustness gap where a transient network failure could crash the whole agent server. The top-level uncaught-exception handler crashes by default and only log-and-continues for a tight allowlist of known-isolated errors (HTTP double-response races, the Slack reconnect race, standby read-only writes). Network-class failures weren't on that list — so on 2026-06-15, during an API/network rough patch, an uncaught `fetch failed` (the multi-machine lease-wire broadcasting to an offline peer) took the server down (it auto-restarted ~50s later). Network-class tokens (`fetch failed`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`) are now on the recoverable allowlist, so an isolated outbound-fetch failure degrades (log + continue) instead of crashing. The handler logic is untouched; any unrecognized error still crashes (the safe default), and the first-seen-stack logging still surfaces the un-guarded callsite so the real missing `.catch` gets fixed.

## What to Tell Your User

Nothing they need to do. The practical effect is fewer unexpected restarts: during a brief internet/API/peer-machine outage, the agent now rides it out and keeps serving instead of restarting itself over a failed background network call.

## Summary of New Capabilities

- The crash safety net treats transient network-class failures (`fetch failed` and common connection error codes) as recoverable — log-and-continue, not crash — while keeping the safe default (crash) for every unrecognized error.

## Evidence

- Unit tests: `tests/unit/uncaughtExceptionPolicy.test.ts` — 11/11 pass, including the new network-class positive cases (incl. undici `TypeError('fetch failed')`) and boundary cases proving `assertion failed` / `migration failed` / sqlite / undefined-property errors still crash.
- Root cause in logs: `logs/server.log` 2026-06-15T01:50:28Z `[FATAL] Uncaught exception — closing databases before crash: fetch failed`, preceded by `[lease-wire] broadcast to m_4cbc… became unreachable: fetch failed`.
- Side-effects review + independent adversarial second pass (concur): `upgrades/side-effects/cmt1548-uncaught-fetch-degrade.md`.
