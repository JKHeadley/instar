# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Framework-Onboarding Mentor System — the live mentor loop, shipped dormant (§19.4).** This wires
the previous three pieces (ledger, auto-capture, Stage-A boundary) into one heartbeat: a pure tick
that runs a leak-detector canary, a fail-closed budget gate, and a durable safe-window check, then
spawns a constrained sub-agent (empty tool grant) to drive the mentee as the user, runs the leak
detector on the transcript, runs Stage-B forensics, and captures findings to the ledger funnel. The
orchestration is a pure function with every side-effect injected, so the structural guarantees live
in code, not a prompt. A new built-in job (`mentor-onboarding`, off by default) is a thin timer that
pokes `POST /mentor/tick`; the real work runs in-process.

It ships **dormant**: `mentor.enabled=false` / `mode='off'`, so `POST /mentor/tick` returns
`{ran:false, reason:'disabled'}` and nothing spawns, spends, or contacts anyone. There is no
mentee-delivery path wired yet — promotion off → dry-run → live (with the documented live-promotion
blockers closed first) is the human's, via the graduated-rollout track.

## What to Tell Your User

- The mentor's full loop now exists end-to-end but is switched off — it can't act until you turn it
  on, and even then it starts in an observe-only dry-run.
- When you do enable it, it refuses to run under budget pressure or while anything else is working,
  checks its own leak-detector is alive before every tick, and logs every run so it can't quietly
  break.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mentor status | `curl -H "Authorization: Bearer $AUTH" http://localhost:<port>/mentor/status` — mode + mentee framework (off by default) |
| Mentor tick | `POST /mentor/tick` — runs one heartbeat (`{ran:false,reason:"disabled"}` until enabled) |
| Built-in mentor job | `mentor-onboarding` (ships `enabled:false`) — heartbeat that pokes the tick |
| `mentor.*` config | `.instar/config.json` — `enabled`, `mode` (off/dry-run/live), `minIntervalMs`, `maxRoundsPerDay` |

## Evidence

Net-new feature, not a bug fix — no prior failure to reproduce. Behavior is proven by tests: 8 unit
tests assert the load-bearing gate ORDER (canary → budget → safe-window → Stage A → leak → Stage B →
capture) and that a **fail-closed budget skip happens before any spawn or contact**; 6 runner tests
prove the dormant short-circuit (disabled config → no work) and the busy/min-interval safe-window;
4 integration tests cover the routes; and 5 e2e tests boot the real server and confirm `/mentor/tick`
is dormant on the production init path and the job template ships `enabled:false`. A dedicated
second-pass reviewer independently audited the spawn/gating logic (concur, 0 blocking concerns).
Affected push-config suite green (3431 + 300 capability tests) vs canonical main.
