# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Fixes a noisy false alarm in the token-burn detector. The `BurnDetector` absolute-share trigger
fired whenever a single attribution key crossed 25% of the trailing-24h token spend — but it had no
"is this still happening right now?" gate. So one heavy session that finished hours ago kept
re-tripping the alarm every cooldown for a full 24h while it aged out of the window, producing a
stream of self-contradictory "consumed 67% of 24h spend … Projected 0 tokens in next 24h" messages
(the current rate was zero — the burst was over).

The fix adds an **activity gate** to the absolute-share trigger: it only fires when the key is
actively spending in the last hour (`tokens1h > absoluteShareActivityFloorTokens`, default `0` =
require strictly positive recent spend). A high 24h share with zero current rate is a finished burst,
not a live burn, and is now silenced. This brings the absolute-share trigger to parity with the
baseline-divergence trigger, which already gated on `rollingBaselineFloor`.

Also added an operator control surface under `monitoring.burnDetection` in `.instar/config.json`
(all fields optional; absence preserves the shipped defaults):

- `enabled: false` — master kill-switch for the whole burn-detection + auto-heal system.
- `absoluteShareThreshold` (default `0.25`), `absoluteShareActivityFloorTokens` (default `0`) — tune
  the absolute-share trigger.
- `alertTopicId` — which Telegram topic burn alerts post to.
- `autoThrottle` / `autoThrottleOnUnknown` — tune the bounded auto-throttle runbook.

The alert text dropped the internal "Phase 3 is observation-only; Phase 4 wires alerting" jargon.

This is a code change that applies fleet-wide on update; a content-sniffed, idempotent
`PostUpdateMigrator` addition teaches existing agents what the alert means and how to mute it.

## What to Tell Your User

- **Those repeated "a component is using more than a quarter of the token budget" alerts are fixed**:
  "The token-burn alert used to keep re-firing for a full day after one heavy session finished, even
  though nothing was spending anymore. It now only alerts when something is actually burning tokens
  right now, so the repeated noise stops. If you ever want it fully off, I can silence it for you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Burn-alert activity gate | Automatic — the absolute-share trigger now requires positive last-hour spend, so a finished burst no longer re-alarms for 24h. |
| Burn-detection off-switch | Set `monitoring.burnDetection.enabled` to `false` in `.instar/config.json` to silence all burn alerts. |
| Burn-detection tuning knobs | `monitoring.burnDetection.absoluteShareThreshold`, `absoluteShareActivityFloorTokens`, `alertTopicId`, `autoThrottle`, `autoThrottleOnUnknown` — tune without code changes. |

## Evidence

Verification:

- Unit (`tests/unit/burn-detection-phase-3.test.ts`, +3 tests): a finished burst (high 24h share,
  zero 1h spend) emits no signal; a dominant key actively spending now still fires absolute-share; a
  positive `absoluteShareActivityFloorTokens` gates out a 1h rate at/below the floor. All 19 phase-3
  tests + 65 burn-detection tests across phases 3–6 green.
- Unit (`tests/unit/PostUpdateMigrator-tokenBurnAlerts.test.ts`, new, 5 tests): the awareness section
  is added on migration, is idempotent, preserves existing CLAUDE.md content, skips gracefully when
  CLAUDE.md is missing, and the source template emits it for fresh installs.
- Parser safety: the `BurnVerifier.extractTokensLast1h` regex `/Projected ([\d,]+) tokens in next
  24h/` still matches the reworded alert string (the "at the current rate" suffix is after the
  captured portion) — verified against the existing phase-4/5/6 fixtures.
- `tsc --noEmit` clean; the existing `enabled: false` guardrail test still passes.
