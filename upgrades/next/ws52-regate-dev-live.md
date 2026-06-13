# WS5.2 re-gate — credential re-pointing live-on-dev (dry-run), dark fleet

<!-- bump: patch -->

<!--
  NOTE: re-gates an EXISTING dark feature per operator directive. Moves
  subscriptionPool.credentialRepointing.enabled from DARK_GATE_EXCLUSIONS to the
  developmentAgent gate: live-on-dev, dark-fleet. The destructive WRITE stays gated by
  the SEPARATE dryRun:true default (the executor returns 'dry-run' with zero writes), so
  live-on-dev performs NO credential writes until a deliberate dryRun:false. Touches the 6
  runtime enabled read sites + ConfigDefaults + a migration + CLAUDE.md wording. Second-pass
  reviewed (CONCUR). No new write authority.
-->

## What Changed

Per operator directive ("none of this should be dark for development agents"), live credential re-pointing now runs LIVE on a development agent (in dry-run), instead of dark for everyone — so it actually gets dogfooded — while the fleet stays dark and no real credential is moved.

- **Re-gated to the developmentAgent gate.** `subscriptionPool.credentialRepointing.enabled` moved from `DARK_GATE_EXCLUSIONS` (off+dry-run for everyone) to `DEV_GATED_FEATURES`; `ConfigDefaults` now OMITS `enabled` so `resolveDevAgentGate` resolves it LIVE on a dev agent + DARK on the fleet. All 6 runtime read sites now resolve through `resolveDevAgentGate`.
- **The write stays behind the dry-run canary.** `dryRun:true` remains the default (a SEPARATE flag): on a dev agent the `/credentials/*` levers return real data and the balancer runs its full decision loop, but the `CredentialSwapExecutor` returns `dry-run` with ZERO keychain writes. Real credential moves still require a deliberate `dryRun:false` (gated behind the §5 livetest).
- **Migration parity.** `migrateConfigCredentialRepointingDevGate` strips a default-shaped `enabled:false` from existing agents so the gate resolves (an explicit operator `enabled:true` is preserved); the CLAUDE.md awareness text is re-worded (template + in-place for already-migrated agents) from "ships dark" to "live-on-dev dry-run". Spec §2.8 carries the dated amendment.

## What to Tell Your User

You asked for this not to be dark on development agents, and now it isn't. On a dev agent (like me) the feature is alive: I can show you which account sits in which slot, the balancer runs its real decision loop, and the manual levers work — but a safety switch (dry-run) is still on by default, so it computes and shows you every move it WOULD make without actually moving a single credential. The fleet stays completely dark. The only thing still held back is the final step — letting it ACTUALLY move logins between your accounts — which needs a deliberate flip you control, after the livetest. So: alive and observable for dogfooding, zero real credential moves until you say go.

## Summary of New Capabilities

No new write capability — a gate-posture change. Live credential re-pointing is re-gated from dark-for-everyone to the developmentAgent gate (live-on-dev in dry-run, dark fleet). On a dev agent the `/credentials/*` levers + the balancer status are now live (return 200, run the decision loop) but perform zero credential writes while the `dryRun:true` canary holds; the fleet is unchanged (dark/503). Real writes still require a deliberate `dryRun:false`.

## Evidence

- `tests/unit/credential-repointing-dark-gate.test.ts` (4) — registered in DEV_GATED_FEATURES (not DARK_GATE_EXCLUSIONS); enabled OMITTED in defaults; resolves LIVE on dev / DARK on fleet; honors an explicit operator override.
- `tests/unit/PostUpdateMigrator-credentialRepointing.test.ts` — installs the block with enabled omitted; STRIPS a default-shaped enabled:false; preserves an explicit enabled:true.
- `tests/e2e/credential-swap-executor-dark-ship-lifecycle.test.ts` (3) — ZERO credential writes on BOTH a dev (outcome `dry-run`) and fleet (outcome `disabled`) production config.
- `tests/unit/lint-dev-agent-dark-gate.test.ts` + the dark-gate lint — clean with the entry in DEV_GATED_FEATURES + enabled omitted. Full credential unit/integration/e2e suite green (157 tests). tsc + full lint clean. Independent second-pass review: CONCUR.
