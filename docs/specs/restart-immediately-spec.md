---
title: "Primary-developer mode — never defer my own update-restarts behind active sessions"
date: 2026-06-01
author: echo
review-convergence: internal-plus-conformance-2026-06-01
approved: true
approved-by: Justin
approved-via: "Telegram topic 13435 (2026-06-01): \"You are the primary developer, so you need to be updating your version to the latest version every time a newer version is deployed. I would like to make that the standard for you (but not for all instar agents).\""
eli16-overview: restart-immediately-spec.eli16.md
---

# Primary-developer mode (`updates.restartImmediately`)

## Problem

The instar developer's own agent (Echo) must always run the latest shipped
version — it is the agent that builds and dogfoods the fleet, so a stale Echo
tests stale behavior and ships against the wrong baseline. But the update path
is deliberately conservative for the *fleet*: `UpdateGate` defers a restart
**indefinitely** while any healthy session exists (it never kills active work
for an update), and the optional restart window further holds restarts to a
quiet time-of-day band.

For a normal user agent that is correct — their work matters more than being
current. For the developer's agent it is backwards: Echo accumulated a 5+ hour
restart deferral and sat **two releases behind** (running 1.3.173 while 1.3.179
was downloaded and waiting) purely because a few long-lived sessions were
"active". Justin: *"I'm tired of waiting on things because of active sessions."*

Critically, deferring buys **nothing** here: a server restart does **not** kill
the agent's tmux sessions — they survive and resume via CONTINUATION. The only
real cost of restarting is a brief (~60s) messaging blip while the server
process bounces. So protecting sessions from that blip, at the price of running
stale code for hours, is a bad trade *for the developer's agent specifically*.

## Decision

Add a per-agent, opt-in config flag `updates.restartImmediately` (default
**false**). When true, the agent's update restarts are **never deferred** — not
for active sessions, not for the restart window. The agent always rolls onto the
latest version as soon as it is downloaded.

This is explicitly **not** a fleet default. Justin's directive was "the standard
for *you* (but not for all instar agents)". Default-false means every other
agent keeps the existing session-aware + window-aware deferral untouched; only
Echo's `.instar/config.json` sets the flag.

## Design

Single behavioral switch, threaded through the two places that defer:

1. **`UpdateGate` (the session-deferral)** — new `alwaysRestartImmediately`
   config (default false). `canRestart()` short-circuits at the very top: when
   set, it `reset()`s any in-flight deferral and returns `{ allowed: true }`
   *before* listing sessions, so the deferral clock never even starts. A runtime
   `setAlwaysRestartImmediately(value)` setter lets a live config edit (via
   `LiveConfig`) flip the mode without a restart; turning it on clears a held
   deferral so the pending restart proceeds at once.

2. **`AutoUpdater` (the window-deferral + wiring)** — new `restartImmediately`
   config (default false). It constructs `UpdateGate` with the flag, and its
   `gatedRestart()` skips the restart-window wait when the flag is set (the
   session gate is already satisfied by the `UpdateGate` short-circuit). The
   **cascade dampener and same-version cooldown are intentionally preserved** —
   they only coalesce genuinely back-to-back restarts (max ~15 min) and protect
   against restart loops; they do not strand the agent on a stale version.
   `reloadDynamicConfig()` re-reads `updates.restartImmediately` each tick and
   pushes changes into the gate, so toggling the flag on disk takes effect
   without a restart.

3. **Wiring** — `src/commands/server.ts` maps `config.updates?.restartImmediately
   ?? false` into the `AutoUpdater` config. `UpdateConfig` (types.ts) gains the
   typed field. Both `UpdateGate.getStatus()` and `AutoUpdater.getStatus()`
   surface the active value, so `GET /updates/status` shows whether the mode is
   on (observability — Justin can verify it).

### Why not just bypass the gate at the call site?

Because the gate is the single, tested chokepoint for "is it safe to restart".
Putting the developer-mode decision *inside* the gate (and the window check
beside it) keeps one source of truth, makes the behavior unit-testable in
isolation, and means any future restart path automatically inherits the mode.
This mirrors the single-funnel pattern used elsewhere (SafeFs/SafeGit).

## Safety / blast radius

- **Default false** → the entire fleet is byte-unchanged. All 19 existing
  `UpdateGate` + 18 existing `AutoUpdater` tests pass without modification.
- **No session is killed.** "Restart immediately" restarts the *server process*;
  the agent's interactive/job tmux sessions persist and resume via CONTINUATION.
  The flag changes *when* the server bounces, never *whether* sessions survive.
- **No loops.** The same-version 30-min cooldown and the cascade dampener still
  apply, so a flapping release cannot induce a restart storm.
- **Migration parity:** this is a per-agent opt-in, intentionally *not*
  migrated onto existing agents (that would change fleet behavior, which the
  directive explicitly forbids). New + existing agents default to false via
  absence; only the developer's agent sets it. No `migrateConfig` entry is
  added, by design.

## Testing

- **Unit (`UpdateGate`)**: with the flag, `canRestart` allows a healthy active
  session that blocks by default; the deferral clock never starts; the monitor
  is never consulted (pure short-circuit); default-false still blocks; the
  runtime setter flips a deferring gate to allowed and back.
- **Unit (`AutoUpdater`)**: default `restartImmediately` is false; constructing
  with `restartImmediately: true` is reflected in `getStatus().restartImmediately`
  (sourced from the gate's status — proves the flag reached the real gate
  instance, not just a config echo).

## Rollout

Ship the flag (default off → no fleet impact), then set
`updates.restartImmediately: true` in Echo's own `.instar/config.json`. From then
on Echo auto-applies and restarts onto every new release as soon as it lands.
