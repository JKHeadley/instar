# Claude transcript resolution honors the session's live config home

<!-- bump: patch -->

## What Changed

Every transcript-based liveness read (the Window 32 heartbeat predicate, the
session manager's freshness and drain probes, session-recovery growth
verification, the stale-session backstop, and the session reaper's idle
proof) now resolves a Claude Code session's transcript under the session's
live `CLAUDE_CONFIG_DIR` instead of always under the default Claude home.
Subscription-pool-routed sessions were previously invisible to all of them.

## What to Tell Your User

Sessions running on a pooled Claude subscription are no longer mistaken for
silent or dead just because their transcript lives in a different Claude
configuration folder.

## Summary of New Capabilities

- `resolveFrameworkTranscriptPath` accepts an optional `configHome`; for
  Claude Code it routes under `<configHome>/projects`.
- The W32 liveness sampler, the session manager's transcript probes, the
  session-recovery growth check, the stale-session backstop, and the session
  reaper (via a new optional `configHomeForSession` dep) read the session's
  real config home from its tmux environment.
- For pooled sessions, drained-close, idle reaping, and context-wall recovery
  now behave as they already did for every other session.

## Evidence

The booted production-path lifecycle test now runs with no transcript
override and a config-home-routed transcript: it fails without the consumer
change (the run never reaches `active`) and passes with it. Unit tests pin
precedence (`rootOverride` > `configHome` > default), framework isolation,
and a real `SessionManager` probe on both sides of the boundary.
