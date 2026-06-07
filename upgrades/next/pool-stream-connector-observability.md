# Pool-stream connector — observability + bounded mint (live-verify fix)

## What Changed

Live verification of cross-machine dashboard streaming found the request starting but no terminal output ever arriving — and no error either: the connector that opens the upstream link to a peer swallowed every outcome silently, and its ticket-mint call had no explicit timeout, so a wedged mint could hang indefinitely (the stream never opened AND never errored, leaving the dashboard silent forever). This adds (a) an explicit 10s timeout on the mint so it fails honestly instead of hanging — a bounded failure surfaces peer-stream-lost / unreachable to the user — and (b) per-step logging (mint attempt/result, upstream open/close/error) on both the requesting connector and the serving mint verb, so the live path is finally observable.

## What to Tell Your User

Nothing user-facing — this makes the cross-machine streaming path debuggable and stops a silent hang. (The click-to-stream feature itself is being finished; this is the diagnostic that unblocks it.)

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- Explicit 10s timeout on the connector's `pool-stream-ticket` mint (no more silent indefinite hang).
- Per-step connector logging (`[pool-stream-connector]`) + serving-side mint-verb logging (`[pool-stream-ticket]`).

## Evidence

- Live-verify (2026-06-07): laptop /ws remote subscribe returned `subscribed` then 22s of silence (no output, no error); the Mini had no `stream-tickets.json` (never minted). Root: silent-hang + no observability. This fix makes the failure visible and bounded; re-verify reads the new logs.
- tsc clean. Behavior change is limited to bounding a previously-unbounded call + logging.
