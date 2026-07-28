# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Completes the silently-stopped trio shipped in 1.2.41. That release announced two new watchdogs — SocketDisconnectSentinel and ActiveWorkSilenceSentinel — as "wired into server startup." They were not: both shipped as standalone, tested detector classes that the server never actually instantiated, so on every agent they were dead code. This release is the missing wire-up that turns them on.

**The gap.** The detectors were correct and unit-tested, but nothing constructed or started them. A grep made it obvious: the RateLimitSentinel they were modeled on is referenced from six files; both new sentinels were referenced from zero outside their own definitions. The release notes claimed a behavior that did not exist.

**The fix.** A new wiring module builds each sentinel's dependencies from the live session manager and starts them at server boot, behind default-on config switches. SocketDisconnectSentinel now self-drives a 15-second scan over every running session. ActiveWorkSilenceSentinel walks the session registry every 60 seconds and — importantly — only flags sessions whose latest screen shows active work (a spinner, a running tool, an "interrupt" hint), so a session simply waiting for you is never mistaken for a frozen one. All escalations route through the existing tone gate, so you only hear about something that genuinely needs a yes-or-no from you.

## What to Tell Your User

- The two silent-stop watchdogs announced last release are now actually running. Before this, they were installed but switched off, so a dropped connection or a frozen background session could still go unnoticed.
- You will not get noise from sessions that are just idle and waiting for you — only from sessions that were genuinely working and then froze, or that lost their connection.
- Both watchdogs can be turned off per-agent in config if you ever need to, and they are on by default.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| SocketDisconnectSentinel (live) | On by default; disable via config.monitoring.socketDisconnectSentinel.enabled=false |
| ActiveWorkSilenceSentinel (live) | On by default; tune config.monitoring.activeWorkSilenceSentinel.silenceThresholdMs; disable via .enabled=false |

## Evidence

- Spec: `docs/specs/silently-stopped-trio.md` (with ELI16 companion). Side-effects: `upgrades/side-effects/silently-stopped-trio-wiring.md`.
- The gap, reproduced: a grep for either sentinel name across the source returned only its own definition and test files — no construction, no start call.
- Tests: 30 new tests — wiring-integrity and active-vs-idle semantics (24), self-driving scan loop (3), and an end-to-end integration test that drives both sentinels through the tone-gated attention path and asserts an idle session is never escalated (3).

## Rollback

Per-sentinel config kill switch (no release needed), or revert the wiring module plus the server-startup block and the SocketDisconnectSentinel start/stop additions. No persistent state to clean up.
