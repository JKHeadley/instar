---
title: "Enable-layer coherence (low-risk half) — telemetry deadlock + broken toggles + an enableAction-validity guard"
slug: enable-layer-coherence
status: draft
approved: true
approved-by: Justin
approved-via: "Telegram topic 12702 (2026-05-25) — Echo proposed taking 'the LOW-RISK half of the coherence cleanup — fixing the lying on/off switches and the telemetry deadlock (objective bug-fixes, no judgment calls)' while holding the two judgment calls; Justin: 'Yes, approved.'"
review-convergence: "inherits feature-activation-coherence iter-1 convergence (reports/feature-activation-coherence-convergence.md) — this is the M5-recommended split's low-risk spec-1, scoped to objective bug-fixes only; plus empirical validation (the enableAction-validity guard caught a real second bug, `feedback`, during implementation)."
date: 2026-05-25
author: echo
parent-spec: docs/specs/feature-activation-coherence.md
eli16-overview: enable-layer-coherence.eli16.md
---

# Enable-layer coherence (low-risk half)

## One-paragraph summary

This is the M5-recommended split's **low-risk spec-1** of the feature-activation-coherence work — scoped to objective enable-path bug-fixes with no design-judgment calls (the behavior-reducing dispositions — autonomous-evolution execution retirement, response-review merge — are deferred to a separate behavior-disposition spec). It fixes three things: (1) the **telemetry enable deadlock** (the heartbeat was only constructed when telemetry was already enabled, so `POST /telemetry/enable` could never turn it on); (2) **two broken feature toggles** (`dispatches` and `feedback` enableActions patched config keys absent from the `PATCH /config` allowlist → 400); and (3) a **build-time enableAction-validity guard** that asserts every feature's enable/disable action targets a real, accepted surface — so this whole class can't recur. The guard found the `feedback` bug during implementation (a second instance of the known `dispatches` class).

## Problem

From the topic-12702 dogfood: the feature catalog advertises toggles that don't work. Three objective, no-judgment instances:
- **Telemetry deadlock:** `telemetryHeartbeat` constructed only `if (config.monitoring?.telemetry?.enabled)` at boot (`server.ts`), but `POST /telemetry/enable` 503s when it's null — chicken-and-egg.
- **Broken toggles:** `dispatches` (and, found by the new guard, `feedback`) have FeatureDefinition enableActions that `PATCH /config {<key>:...}` for a key not in the route's allowlist → 400. Both are real config keys (`types.ts`: `dispatches?`, `feedback?`; read in `server.ts`).
- **No guard:** nothing asserted that an enableAction targets a patchable surface — which is exactly how these shipped.

## Non-goals

- Not the behavior-reducing dispositions (autonomous-evolution execution retirement, response-review merge) — separate spec, separate side-effects + cross-model review.
- Not the `/features` derived-state / runtime-probe map (convergence B2) — that's the larger Part-1.1 work; deferred to the behavior/enable-layer-2 increment.
- Not changing what telemetry sends or to whom; Echo's telemetry stays off.

## Design

1. **Telemetry: always-construct, gate the effects.** Construct `TelemetryHeartbeat` unconditionally at boot, passing `config.monitoring?.telemetry ?? { enabled: false }`. Construction is cheap/pure; `start()` and `submit()` already `return` early when `!config.enabled` (verified: `TelemetryHeartbeat.test.ts` "does not start/send when disabled"). So a constructed-but-disabled heartbeat never loops and never egresses, and `POST /telemetry/enable` (which 503s only when the heartbeat is null) now works. After enable, config is flipped and the next restart starts submissions — matching the endpoint's existing "restart" contract.
2. **Allowlist the two real keys.** Add `dispatches` and `feedback` to the `PATCH /config` allowlist, extracted to an exported module-scope `PATCHABLE_CONFIG_KEYS` (single source of truth so the guard can't drift from the route).
3. **enableAction-validity guard.** `tests/unit/feature-enableaction-validity.test.ts` asserts, for every `BUILTIN_FEATURES` entry: a `PATCH /config` enable/disable action's body keys are all in `PATCHABLE_CONFIG_KEYS`; a non-`/config` action targets a known dedicated endpoint (`/api/files/config`, `/telemetry/enable`, `/telemetry/disable`). Its absence is what let these bugs ship.

## Testing (tiers)

- **Unit:** the enableAction-validity guard (new, 15 tests) — both sides of the boundary (valid `/config` keys, valid dedicated endpoints, and a regression assertion for `dispatches`). Telemetry self-gating already covered by `TelemetryHeartbeat.test.ts` (disabled → no start/no send).
- **Integration/route:** `telemetry-routes.test.ts` covers the enable route with a constructed heartbeat (the post-fix runtime state). The always-construct change is a boot-logic change covered by typecheck + the existing e2e server-boot suite.
- **Regression:** touched-area suite green (telemetry routes, TelemetryHeartbeat, validity = 99 passing); typecheck clean.

## Migration parity

Pure server-side code (`src/commands/server.ts`, `src/server/routes.ts`) + a test. Ships to every agent on the normal server update; no agent-installed file changes, no `PostUpdateMigrator` work. The allowlist additions and always-construct take effect on the next server build for all agents.

## Rollback

Each fix is independently revertable. Telemetry: revert to conditional construction (deadlock returns; no other effect — fail-safe). Allowlist: remove the two keys (toggles 400 again). Guard: delete the test. No state/schema changes.

## Signal-vs-authority compliance

No new gate, no blocking authority added. The allowlist is a passive accept-list; the guard is a build-time test. Telemetry authority (consent + enabled flag) is unchanged.

## Side-effects review

See `upgrades/side-effects/enable-layer-coherence.md`. Headline: always-constructing telemetry is side-effect-safe because start/submit self-gate (tested); the allowlist additions only *enable* two toggles that were inert; the guard is build-time only. Worst case of any bug here is "behaves like today."

## Success criteria

- `POST /telemetry/enable` succeeds without a pre-existing enabled state.
- `dispatches` and `feedback` toggles function via `PATCH /config`.
- The enableAction-validity guard is green and would fail the build on any future enableAction pointing at a non-patchable surface.
- No regression; telemetry egress unchanged (off for Echo).
