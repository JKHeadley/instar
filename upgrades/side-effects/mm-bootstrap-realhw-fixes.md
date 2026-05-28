# Side-Effects — Multi-Machine Bootstrap Real-Hardware Fixes

Spec: `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` (Round 2 — defects found
driving the live two-machine proof on real hardware, 2026-05-28, topic 13481).

Six distinct bootstrap defects that blocked a clean two-machine bring-up — each
verified against the live mesh (laptop + Mac mini, Bob untouched) before fixing,
each with a regression test.

## What changed

1. **No-upstream silent push (`src/core/GitSync.ts`, `src/commands/init.ts`).**
   `commitAndPush` is now upstream-aware: it splits commit from push and
   `pushCurrentBranch()` sets `-u origin <branch>` on the first push, surfacing a
   real push failure via DegradationReporter instead of swallowing it. init's
   connect-to-existing-repo path also sets `push.autoSetupRemote`/`push.default`.

2. **Join scaffolds no config.json (`src/commands/machine.ts`).** `join` now
   writes a complete machine-local `config.json` (fresh authToken, port; new
   `--port` flag) via the pure, tested `buildJoinedConfig()` when the cloned home
   lacks one — previously the standby booted unauthenticated on bare defaults.

3. **Commit-signing broke every commit (`src/core/GitSync.ts`,
   `src/commands/machine.ts`, `src/commands/server.ts`).** Unified the machine
   key filename on the canonical `signing-key.pem` (join now uses
   `generateIdentity`; readers updated). `configureCommitSigning` now derives the
   `.pub`, test-signs for real, and enables `commit.gpgsign` ONLY if that works —
   otherwise it explicitly disables signing (commit verification is a no-op stub,
   so unsigned is safe; broken signing fails every commit).

4. **Registry conflict-marker corruption (`src/core/GitSync.ts`,
   `src/core/FileClassifier.ts`).** Two root causes: (a) `classify`/`tryAutoResolve`
   re-ran `path.relative` on already-relative git paths, mis-classifying
   `machines/registry.json` as `llm` so the deterministic resolver was effectively
   dead (now cwd-independent — only relativize absolute paths); (b) a clean-exit
   `--autostash` pop left unmerged files the catch-block resolver never saw — new
   `resolvePostPullAutostashConflicts()` runs the deterministic merge post-pull and
   drops the redundant autostash.

5. **Lease-renewal churn starves standby pushes (`src/core/GitSync.ts`).** Sync's
   push now uses `commitAndPushWithRebaseRetry()` — on a non-fast-forward rejection
   it pull-rebases (+ resolves) and re-pushes, bounded, so a standby converges
   within one sync. Kept entirely out of the lease CAS path (GitLeaseStore).

6. **`wakeup --force` propagation (`src/commands/machine.ts`).** Force-wakeup (and
   the no-awake path) now claim a real signed +1-epoch lease via
   `FencedLease.buildAcquisition` (`claimLeaseForSelf()`), persist it with the
   holder's freshness fields, and best-effort push — so the lease authority (not
   just the local role, which the server's reconcileRoleToLease would revert)
   reflects the takeover and reaches the peer.

## Side effects

- New `--port` option on `instar join`.
- `instar join` now writes `.instar/config.json` (with a fresh authToken) for the
  joined home if absent; pre-existing configs are untouched (only `--port` may set port).
- A machine where SSH signing cannot load the key now commits UNSIGNED (was: every
  commit failed). No verification regression — `verifyPulledCommits` is a no-op.
- `configureCommitSigning` writes a `<signing-key.pem>.pub` next to the key when signing works.
- `wakeup --force` now requires the signing key (exits with a clear message if missing).

## Rollback

Revert the PR. No data migration. Existing meshes: the GitSync push/merge changes
are backward-compatible (relative-path handling is strictly more permissive; the
autostash/upstream paths only add recovery). config.json scaffolding only writes
when absent. No `.instar` schema change.

## Migration parity

No agent-installed file template changed (no settings.json/hook/CLAUDE.md/skill
edits). Changes ship in the instar dist and reach existing agents on update.

## Addendum — exactly-once ingress default-ON (2026-05-28)

`src/core/seamlessnessConfig.ts`: `multiMachine.exactlyOnceIngress` default flipped
`false → true`, per the spec's "flip once the live test-as-self passes" gate.

**Proof:** a REAL message from the operator's own Telegram (driven via the
logged-in Playwright profile — update_id 969389534) was forwarded into the live
two-machine mmtest3 mesh and handled EXACTLY ONCE: first delivery
`forwarded:true (spawn)`, redelivery `deduped:true`. No false-drop on the
critical path.

**Safety of default-on:** the dedupeKey is the Telegram `update_id` (unique per
update), so two DISTINCT messages can never collide — only a genuine same-update
redelivery is dropped. The gate is FAIL-OPEN (any ledger error falls through to
normal routing). Opt out with `multiMachine.exactlyOnceIngress: false`.

**Rollback:** set the default back to `?? false` (one line) — fully reversible,
no data migration.
