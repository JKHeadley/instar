# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — live-readiness hardening.** Closes the three things the
§19.4 reviewer flagged as must-haves before the mentor can ever be promoted to `live`: the tick is
now fire-and-forget (a slow helper-spawn can't hang the request — the result lands in
`/mentor/status`); the helper-spawn now kills its session and bails cleanly if it overruns (no
orphaned panes, no half-read transcripts); and `live` mode now has a real, safe delivery path — it
appends the message to a durable per-mentee outbox the mentee's running session picks up, instead of
spawning a fresh counterpart session (the structural fix for the agent-to-agent message loop). Still
dormant by default.

## What to Tell Your User

- The mentor's plumbing is now safe to switch on without it hanging or leaking sessions, and when it
  eventually talks to the mentee it does so the calm way (drop a note in their inbox, no spawning).
- Nothing's changed day-to-day; it's still off until you turn it on, and turning it fully live is
  still gated behind your sign-off.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Async mentor tick | `POST /mentor/tick` returns 202; outcome in `GET /mentor/status`.lastResult |
| Persist-only delivery | live mode appends to `server-data/mentor-outbox/<framework>.jsonl` (never spawns) |

## Evidence

Net-new hardening of a dormant feature, not a bug fix — no prior production failure. Proven by tests:
the delivery path is asserted to fire **only in live mode and never in dry-run** (and to no-op safely
when unwired); the async tick is asserted to return 202 with the result landing in `status.lastResult`
and the in-flight guard preventing overlap; the spawn-kill-on-timeout path throws after killing the
session so the tick captures a clean failure rather than a partial transcript. 27 mentor tests +
route-completeness/discoverability gates; affected push-config suite green (745) vs canonical main.
