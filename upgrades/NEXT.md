# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

PR 8 of the tunnel-failure-resilience chain. This is the self-heal piece: once you've been moved onto a backup tunnel because Cloudflare was down, the agent now watches for Cloudflare to come back and automatically switches you off the backup — without leaving your dashboard link dead for even a moment.

**Patient, not twitchy.** The hard part of switching back is doing it at the right time. A flaky network can let one Cloudflare check succeed and then fail again seconds later; switching on that single success would thrash your link back and forth. So the agent waits for several healthy checks in a row (3 by default, spanning about five minutes) before deciding Cloudflare is genuinely back. A single failure resets the count.

**Seamless, not jarring.** When it does switch, it brings the real Cloudflare link fully up and verifies it actually serves before touching the backup. Only then does it point your dashboard at the new link and tear the backup down. Your link never goes dead in the gap. As the switch completes — the backup is now gone — the credential rotation from the previous release kicks in, so the backup operator can't reuse anything they saw.

## What to Tell Your User

- If you ever got moved onto a backup link, you don't have to do anything to get back to normal — the agent will switch you back to your regular Cloudflare link on its own once Cloudflare is reliably healthy again.
- It won't flip back and forth on a flaky connection; it waits for a steady run of healthy checks first.
- When it switches back, your dashboard PIN gets refreshed (from the previous release's security cleanup), so an open tab will ask you to sign in again.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Automatic switch-back to Cloudflare | Automatic — fires after 3 consecutive healthy Tier-1 checks while on a backup relay |
| Atomic new-then-old switch | Automatic — the recovered link is verified and live before the backup is torn down, so the dashboard link never goes dead mid-switch |

## Evidence

- Spec: `specs/dev-infrastructure/tunnel-failure-resilience.md` Part 5. Side-effects: `upgrades/side-effects/tunnel-self-heal.md`.
- Tests: `tests/unit/tunnel-self-heal.test.ts` (3) drive the probe tick-by-tick: it asserts a switch fires only on the 3rd consecutive success (the relay is still serving after 2), that the switch points the URL at the recovered Cloudflare link, tears the relay down, and rotates credentials; that a failure mid-run resets the counter so it takes a fresh run of 3 (no thrashing on a single lucky check); and that the probe goes inactive once the tunnel is stopped.
- No regression: 101 tunnel tests pass.

## Rollback

Additive. Revert = drop the self-heal methods/fields/constants in `TunnelManager` and the two wire points (the probe start on relay-active entry, the probe stop in `stop()`). No config or persisted-state change — the `self-healing` lifecycle state already existed.
