# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = foundation layer for an upcoming feature; no user-visible behavior change yet -->

## What Changed

**feat(tunnel): foundation modules for the tunnel-failure-resilience feature.**

This release lands the foundation layer that the upcoming tunnel-failure-
resilience feature is built on. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged +
approved (4 review iterations, 41 material findings folded in across
internal multi-angle review + GPT external review + GPT verification);
this PR is the first of a chain landing the implementation.

What this PR adds (additive only — no existing behavior changes yet):

1. **`TunnelProvider` interface** (`src/tunnel/TunnelProvider.ts`) — a
   provider abstraction that future tunnel providers (localtunnel, bore)
   will implement alongside the two extracted Cloudflare providers.
   Defines `ProviderTier`, `ProviderName`, `ProviderFailureReason`.

2. **`CloudflareQuickProvider`** (`src/tunnel/CloudflareQuickProvider.ts`)
   — Tier-1 zero-config Cloudflare quick-tunnel implementation
   extracted from the original `TunnelManager.startQuickTunnel`. Owns
   ONLY spawn + URL emission + teardown; retry/reconnect ownership
   moves to the manager in a subsequent PR per the spec's single-owner
   mandate. Forceful stop with SIGINT→SIGKILL escalation preserved.

3. **`CloudflareNamedProvider`** (`src/tunnel/CloudflareNamedProvider.ts`)
   — Tier-1 persistent Cloudflare named-tunnel implementation
   (token-auth and config-file-auth modes). `isAvailable()` returns
   false when neither token nor configFile is configured.

4. **`TunnelLifecycle`** (`src/tunnel/TunnelLifecycle.ts`) — the single-
   writer state machine that will own the tunnel lifecycle once the
   manager is rewritten. Compare-and-swap `transition(expectedFrom, to)`
   guard rejects losing concurrent writes (the error+exit double-handler
   race fix). Monotonic transition epoch drives notification dedup.
   Episode model + cross-episode consent cooldown + rotation-pending
   flag (the boot-recovery mechanism for crash-safe credential
   rotation) all present and tested.

5. **`TunnelNotifier`** (`src/tunnel/TunnelNotifier.ts`) — two-channel
   routing that, once wired in, will route group-topic status text
   (no credentials, ever) separately from owner-DM credential delivery
   (the only credential-bearing channel). Class-based throttling:
   `action-required` (consent prompts) never throttled within an
   episode; `state-change` keyed per `(state, channel)` within a 15-min
   window; `noise` (flap collapse) at most once per episode.

The existing `TunnelManager.ts` and `server.ts` tunnel block are
UNTOUCHED in this PR — current tunnel behavior is identical. Wiring
the new modules into the manager (and retiring the legacy `server.ts`
retry ladders) is the next PR in this chain.

## Evidence

54 new unit tests pass:

- `tests/unit/tunnel-providers.test.ts` — 10 tests covering provider
  interface assertions, `isAvailable()` semantics on token/configFile
  configurations, start-rejection paths on missing prerequisites.
- `tests/unit/tunnel-lifecycle.test.ts` — 32 tests covering the CAS
  guard (rejects losing transitions without mutating state),
  monotonic-epoch increment, valid-transition map enforcement,
  episode lifecycle, exponential consent-cooldown back-off,
  rotation-pending persistence, failure-reason classification,
  CSPRNG nonce generation.
- `tests/unit/tunnel-notifier.test.ts` — 12 tests covering the
  channel-separation invariant (credentials never appear in group
  messages), epoch dedup, action-required-never-throttled, state-
  change per-(state, channel) throttling, flap-collapse emits
  exactly once per episode, sink-error swallowing.

All existing tests still pass. `tsc --noEmit` clean. `npm run lint`
clean.

## What to Tell Your User

This release adds internal scaffolding for a tunnel-resilience feature
coming over the next few releases. You will not notice any behavior
change yet — your dashboard link comes up the same way as before. The
upcoming releases will add failure notification to the Dashboard topic,
backup tunnel providers (asked about in DM before use), and automatic
recovery when Cloudflare comes back online. Each piece ships in its
own release in the chain that starts here.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Provider abstraction internals | Internal — used by the upcoming manager rewrite |
| Single-writer state machine internals | Internal — used by the upcoming manager rewrite |
| Two-channel notifier internals | Internal — wired up in the next release |
