# Side-Effects Review — Framework Permission-Prompt Robustness

Build of the converged spec `docs/specs/framework-permission-prompt-robustness.md`
(6 spec-converge rounds; report `…-convergence.md`). This records the blast radius.

## Files that ship behavior (in-scope)

- **`src/monitoring/PermissionPromptAutoResolver.ts`** (NEW) — the floor itself: two
  pure detectors + a stateful driver. No I/O of its own; everything is DI'd, so it is
  inert until constructed + wired.
- **`src/commands/server.ts`** — UNCONDITIONAL construction (after `guardRegistry`) +
  GuardRegistry registration + `sessionManager.setPermissionPromptResolver`. Additive;
  no existing branch changed.
- **`src/core/SessionManager.ts`** — a private field + setter + a `monitorTick` branch
  (a cheap menu-shape pre-gate on the EXISTING 5-line capture → a fuller capture +
  `evaluate` only on a hit) + a once-per-tick `sweep`. All wrapped in `try/catch` and
  guarded by `this.permissionPromptResolver?` — when the resolver is unset (every
  existing test) the additions are a strict no-op.
- **`src/core/types.ts`** — additive optional config field `permissionPromptAutoResolver?:
  { emergencyDisable?: boolean }` (deliberately NO `enabled`).
- **`src/monitoring/StuckSignatureClassifier.ts`** — a new `StuckKind` member +
  prose-agnostic structural patterns + a lowest-precedence branch. Existing kinds /
  precedence unchanged (its 13 existing tests pass).
- **`src/monitoring/PresenceProxy.ts`** — both `classifyStuckSignature` consumers
  suppress the new kind unconditionally (consumer policy; no classifier-contract
  inversion). Existing 11 + 14 tests pass.
- **`src/monitoring/guardPosture.ts`** — a computed posture key (no persisted `enabled`),
  scoped to a present `monitoring` block so a degenerate empty config (`{}`) adds NO spurious
  posture entry — preserving the GuardPostureTripwire "empty/garbage config ⇒ empty posture"
  robustness invariant. Every real agent carries a `monitoring` block, so the floor is always
  present in production posture.
- **`src/monitoring/guardManifest.ts`** — a `GUARD_MANIFEST` entry.
- **`scripts/lint-guard-manifest.js`** — adds the component to `ADDITIONAL_CANDIDATES`.
- **`src/core/PostUpdateMigrator.ts`** — a content-sniffed `migrateClaudeMd` section
  (Agent Awareness; doc-only, idempotent).

## Blast radius + safety

- **Behavioral authority:** the ONLY new actuation is `sendKey(session,'Enter')` (a
  benign empty submit on a false match) + a deduped Attention defect. No new blocking
  authority; never widens the command allow-set (the destructive `dangerous-command-guard`
  denylist remains independent). Auto-approve accepted under the operator
  full-machine-access trust model.
- **Hot path:** the `monitorTick` pre-gate reads the already-captured 5-line string —
  ZERO extra captures in the common (no-menu) case; a fuller capture happens only on a
  menu-shape hit (rare). On the fleet that fuller capture is synchronous (bounded by the
  existing `execFileSync {timeout:5000}`), accounted for honestly in the spec.
- **Bounded accumulation:** both state maps evict on cleared-tick + session-exit + TTL;
  the audit log is size-bounded with rotation (8 MB); audit logs static pattern NAMES
  only, never raw pane text (no secret leak).
- **Always-on, no stale-false trap:** no persisted `enabled` (a stale `false` could
  re-disable the safety — the exact trap that caused the bug). Only opt-out is
  `monitoring.permissionPromptAutoResolver.emergencyDisable` (absent ⇒ on). A disabled
  floor surfaces as an incident in `GET /guards`.

## Migration / rollback / surfaces

- **Migration:** no persisted flag to backfill; existing wedged sessions auto-recover on
  the server restart that deploys the update (the monitor loop picks them up next tick).
  CLAUDE.md note ships via `migrateClaudeMd` (existing agents). *Follow-up (minor):* the
  new-agent `generateClaudeMd` template parity is not yet added.
- **Rollback:** `emergencyDisable: true` (one config line; read live). The whole change
  is additive + reversible.
- **HTTP surface:** none new — reuses the existing `GET /guards`.
- **Multi-machine:** machine-local BY DESIGN (sessions/tmux/state/audit are per-machine;
  a prompt is answerable only on the machine running the session). No replication, no
  cross-machine surface.

## Tests

**No-silent-fallbacks ratchet:** the resolver's re-capture-before-send guard carries an
`@silent-fallback-ok` marker — a re-capture failure is not a silent degradation; it
aborts the send and is recorded as `race-aborted` in the resolver audit. The redundant
outer `sweep` guard in `monitorTick` was dropped (the resolver's `sweep` is internally
guarded). Net ratchet delta: 0 (count stays at the baseline).

3 tiers green: unit (resolver 34 + classifier 4 + guardPosture 5 + PresenceProxy 3),
integration 4 (DI seam → exactly one Enter + audit privacy + no-send-when-generating +
no-send-when-emergency-disabled + guardStatus reflects the off-switch), e2e 4
(feature-alive: posture + guardStatus ON by default, OFF only on explicit
emergencyDisable). tsc clean; full lint suite clean.

**CI-fix follow-up (post-merge-prep):** a full-unit-suite run surfaced three tests the
local pre-push subset missed: (1) `GuardPostureTripwire` "empty/garbage config ⇒ empty
posture" — the computed floor key was added unconditionally, so it appeared for `{}`;
fixed by scoping the key to a present `monitoring` block (above). (2) The floor's own
`guardPosture-permission-prompt` + `permission-prompt-floor-alive` empty-config
assertions were reconciled to that scoping (the always-on proof now lives in the
`monitoring:{}` cases; a bare `{}` adds no spurious key). (3) `feature-delivery-completeness`
required the `migrateClaudeMd` "Permission-Prompt Floor" section be registered in
`legacyMigratorSections` (migrator-only awareness; the `generateClaudeMd` template parity
remains the tracked minor follow-up). `src/data/builtin-manifest.json` is a gitignored,
build-time-generated artifact — its "up-to-date" check fails only on a stale local copy
(CI regenerates it fresh) and is not a source change here.
