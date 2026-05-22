# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = TunnelManager rewrite atop the foundation modules; no public API change -->

## What Changed

**feat(tunnel): TunnelManager rewrite — drive providers + lifecycle + notifier through a single owner.**

This release lands PR 2 of the tunnel-failure-resilience chain
(PR 1 was the foundation: provider abstraction + state machine + notifier).
It rewrites `TunnelManager.ts` to drive the foundation modules and
retires the duplicate retry machinery that previously lived in
`server.ts`.

The public API surface is preserved exactly — `start()`, `stop()`,
`forceStop()`, `enableAutoReconnect()`, `disableAutoReconnect()`,
`getExternalUrl()`, plus the `url` / `isRunning` / `state` accessors
all still work as before. Callers (the SleepWake handler, the
`server.ts` tunnel wiring) don't need changes.

What's different inside:

- The manager builds a Tier-1 provider pool from config (the
  `CloudflareNamedProvider` if a token or configFile is set, then the
  `CloudflareQuickProvider`) and drives them in order.
- `start()` runs ONE round of provider attempts; if all fail, it
  rejects (matching the legacy semantics) and the backoff retry runs
  entirely in the background — `start()` does not block the caller
  for the full exponential window.
- A post-start HTTP probe through the public URL confirms the link
  actually serves traffic before the manager declares `active`. A
  provider whose URL emits but does not respond is torn down and the
  next provider tried.
- After the bounded startup-reconnect ladder exhausts (10 attempts
  with exponential backoff up to 5 min), the manager schedules a
  low-frequency 15-minute background probe until a provider connects.
  Placeholder; replaced by the spec's N-consecutive-success
  stability-gated probe in a later PR.
- The single-writer CAS-guarded lifecycle state machine from PR 1 is
  the source of truth for tunnel state. The error+exit double-handler
  race that the concurrency reviewer surfaced cannot cause a
  double-advance through the provider pool.
- The `tunnel.json` state file now includes lifecycle snapshot fields
  (`lastState`, `activeProvider`, `rotationPending`, `consentCooldown`,
  `episode`) alongside the legacy `lastUrl`. Boot recovery reads the
  snapshot to restore the rotation-pending flag and the cooldown
  counter (the rotation lifecycle itself lands in a later PR).

What was removed:

- `server.ts` startup-retry ladder (the 5-attempt loop with 15-120s
  exponential backoff). Deleted.
- `server.ts` background-retry scheduler (the 5/10/20-minute
  `scheduleRetry` callbacks). Deleted.
- The single Lifeline failure message. Deleted. The user-facing
  notification path will flow through the notifier once the sink is
  wired up in the next PR.

What's not yet landed (deliberate, future PRs in this chain):

- Owner-DM channel + inline-button consent UX.
- Tier-2 relay providers (localtunnel) + consent flow.
- Auth token + PIN rotation on relay-episode end + boot recovery.
- Full N-consecutive-success self-heal stability gate.
- The auth-gated tunnel-state route.
- ConfigDefaults migration for the new tunnel config fields.

The lifecycle state machine already supports all of these; the manager
just doesn't transition into the relevant states yet.

## Evidence

16 new unit tests in `tests/unit/tunnel-manager-rewrite.test.ts`:

- Tier-1 happy path: drives the first available provider, skips
  unavailable providers, persists the lifecycle snapshot to disk.
- Reachability probe: rejects a provider whose URL does not pass the
  health check, tears it down, falls through to the next provider.
- Provider failure → next: classifies a rate-limit failure, records
  the failed attempt against the current episode, advances to the
  next provider.
- Stop, forceStop, getExternalUrl, enable/disableAutoReconnect:
  back-compat surface preserved.
- Repeat start returns the same URL while running (mutex preserved).
- Notifier wiring: a transition into retrying after a failure emits
  the couldn't-reach-Cloudflare group message via the injected sink.
- Persistence: rotation-pending flag and consent-cooldown counter
  restored from tunnel.json; corrupted state file ignored.

All 70 tunnel-related unit tests pass (16 new plus 54 foundation
tests from PR 1). Typescript and lint clean. No existing tests
modified.

## What to Tell Your User

You will not notice a behavior change yet. The internals shifted —
your agent now has a single tidy retry engine instead of two
overlapping ones — but your tunnel link comes up the same way it did
before. Failure handling is also unchanged from your perspective in
this release; the next release in the chain plugs the failure path
into a message that goes to your Dashboard topic so you can see what
happened when the link does not come up.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Single tunnel-lifecycle owner | Internal — your tunnel link behavior is preserved |
| Post-start reachability probe | Automatic — prevents broadcasting a dead link |
| Indefinite low-frequency self-heal placeholder | Automatic — agent keeps trying to recover after exhaustion without a restart |
