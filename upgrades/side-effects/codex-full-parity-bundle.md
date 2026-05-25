# Side-Effects Review: Codex Full-Parity bundle (squash for PR)

Squash of the codex-full-parity work onto current main (v1.2.75). Per-fix side-effects
reviews are the companion `codex-parity-*.md` artifacts in this dir; this is the bundle
summary. Spec: docs/specs/codex-full-parity-fixes.md (approved + 5-reviewer converged).

## What's in the bundle
- **P2 asdf binary detection** (Config.ts) — finds Codex via asdf shims + `asdf which`
  (absolute-resolved), memoized. Fixes Codex undetectable on asdf hosts. Live-proven.
- **P2 dashboard model badge** (SessionManager.ts, types.ts) — records the framework-RESOLVED
  model + a `framework` field, not the raw Claude tier alias. Codex sessions show gpt-5.x.
- **P1 Codex Stop review trio** (installCodexHooks.ts, canary) — corrected to mirror Claude
  (response-review + claim-intercept-response + scope-coherence); deferral-detector moved to
  PreToolUse + made Codex-aware (exec_command/cmd); canary asserts the correct trio + locks
  deferral-off-Stop.
- **C3** scope-coherence stop_hook_active re-entry guard (PostUpdateMigrator hook source).
- **P0 auto-arming** (codexHookTrust.ts, codexHookArm.ts + wiring in init.ts/PostUpdateMigrator.ts)
  — instar arms its own project-scoped Codex hooks via Codex's trust flow (idempotent,
  manifest-verified F1, readback F2, never re-enables user-disabled F3, no bypass flags,
  two-prompt tmux driver). Per-agent by path-keyed trust (managed-config rejected, G2).
  **LIVE-PROVEN end-to-end**: fresh agent → armed (no human clicks) → `rm -rf /` BLOCKED.

## Scope / blast radius
- Codex-cli-gated throughout; Claude agents unaffected (model tiers pass through; the Stop/asdf
  changes are codex-specific or additive). Migration parity: always-overwrite hooks + the
  auto-arm runs on update (idempotent, fail-soft, opt-out config.codex.autoArmHooks=false).
- New modules (codexHookTrust, codexHookArm) are additive. asdf detection + model resolution are
  pure runtime (ship with dist, no migration).

## Signal vs Authority / Over-block
- Unchanged split: hook scripts emit signals; server gates hold authority. P0 arms existing
  guards (makes them run), adds no new authority. C3 reduces over-block (loop guard).

## Rollback
- Revert the PR. P0 arming is opt-out via config; the modules are unreferenced if the wiring
  is reverted.

## Tests
- 93 green across the codex-area suites on the merged tree (detectFrameworkBinary,
  session-manager-behavioral, installCodexHooks, canary, deferral-detector, scope-reentry,
  codexHookArm, codexHookTrust, migration-parity). tsc clean. P0 driver live-proven on codey/scratch.
- Tracked follow-ups (not blocking): C4 (canary drift-detect enhancement), B1 (runtime capture of
  last_assistant_message non-empty). <!-- tracked: codex-full-parity -->

## Publish
- PR from codex-parity-merge → JKHeadley/main. Squash-merged.
