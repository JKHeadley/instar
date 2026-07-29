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
- `instar join --dir` retains main's existing spelling and behavior; the duplicate declaration is
  removed, with no option or wire-contract change.
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

## Addendum 2 — fresh-join lease-grab fix (bug #7, 2026-05-28)

`src/core/LeaseCoordinator.ts` + `GitLeaseStore.ts` + `MultiMachineCoordinator.ts`:
a freshly-joined/booted standby evaluated failover-eligibility against a STALE
seed `lastSeen` for the live holder, presumed it dead, and grabbed its lease
(found driving the live handoff demo). Fix: `LeaseStore.syncDown()` (pull, no
write) + `LeaseCoordinator.primeFromDurable()`, called once in
`initializeLease()` before the first `acquireIfEligible()`, so the boot decision
sees the holder's CURRENT heartbeat. Split-brain CAS gate untouched; steady-state
ticks already self-correct — this only closes the boot-time stale-data window.
Test: `tests/unit/lease-fresh-join-prime.test.ts` (with-vs-without priming).
Rollback: revert; no data/schema change.

## Addendum 3 — rebase onto current main (2026-07-29): what survived, and what main already fixed

This PR sat 62 days and 2,182 commits behind. Rebasing it was an audit, and most of it turned out to
be already solved. Recording that honestly rather than reasserting superseded work:

**Restored after the rebased regression tests proved the production hunks were absent:**
- **Commit-signing viability.** Main retained canonical + legacy key-name compatibility in
  `MachineIdentity`, but `GitSync.configureCommitSigning` still read only the legacy filename and
  enabled signing without proving that `ssh-keygen` could use the key. The canonical/legacy lookup,
  public-key derivation, real sign probe, and explicit unsigned fallback are present here.
- **Clean-exit autostash conflict recovery.** Main retained the deterministic registry merger, but
  a successful `git pull --autostash` could still leave unmerged files without entering the
  catch-path resolver. Every successful full-sync pull path now checks that postcondition, resolves
  the files, and drops the redundant autostash once clean.
- **Single `join --dir` registration.** The old branch added a directory option that main had gained
  independently. Keeping both made Commander reject the command graph at startup, so every CLI
  invocation failed before dispatch. The rebase keeps main's existing `--dir` definition and adds
  only the new `--port` option. The built-CLI unknown-command and preflight tests cover startup.

**Superseded by main — dropped, NOT reapplied:**
- **Signing-key filename-only rewrite.** The old PR renamed one reader to the canonical
  `signing-key.pem`. The restored implementation instead retains both canonical and legacy lookup;
  the single-name rewrite remains dropped.
- **Upstream-aware push.** This PR added a `push -u origin <branch>` retry for a branch with no
  upstream. Main already has exactly that, with a fuller comment on why a bare `push` failure is
  indistinguishable from "nothing to sync". Took main's.
- **`exactlyOnceIngress` default-ON.** This PR flipped it unconditionally (`?? true`) on the
  2026-05-28 live proof. Main has since made it STAGE-COUPLED — on only while the session pool is
  actively routing — after the 2026-06-05 incident where a "move to laptop" ran four times. Main's is
  newer and better reasoned; took main's, and dropped this PR's now-contradictory test assertions.
  Main's `exactlyOnceIngress default coupling` suite covers every case the dropped assertions did.
- **Lease-renewal robustness.** This PR's commit was explicitly labelled "(partial)" — a single
  `leaseTickTimer`. Main has the complete workstream: a dedicated TTL/2 `leaseRenewTimer`, a
  `ChurnBreaker` flap circuit-breaker, and a per-process boot id. Reapplying the partial over the
  complete would have been a regression, so that commit was skipped entirely.

**Genuinely unlanded — kept:**
- **Bug #7, fresh-join lease grab.** `primeFromDurable()` / `store.syncDown?()` do not exist on main
  (0 files), and main still performs no priming before `acquireIfEligible()`. A freshly-joined standby
  therefore still evaluates failover eligibility against a stale seed `lastSeen` and can grab a live
  holder's lease. Merged additively into main's richer lease-init block: the prime runs BEFORE all
  three branches (observe-only, defer-preferred, acquire), because it is read-only and the
  observe/defer decisions read the same lease view.
- The remaining bootstrap fixes in the base commit, which applied without conflict.

**Scope split.** The branch also carried two commits for `LEASE-SUBSTRATE-ROBUSTNESS-SPEC`, whose own
HEAD message says "NOT converged — awaiting design-point decision" and whose frontmatter is
`approved: false`. Those are file-disjoint from the code (verified: zero overlap), so they were left
off this branch rather than dragged through a rebase. They belong in their own PR once that design
point is decided — a spec that is explicitly awaiting a decision cannot ride in on a bug-fix PR.

## Addendum 4 — side-effects review for the duplicate CLI option correction

**Decision-point inventory.** No judgment or block/allow decision changes. This removes a duplicate
Commander registration so the existing command graph can be constructed.

1. **Over-block:** No block/allow surface — over-block is not applicable.
2. **Under-block:** The change corrects the observed duplicate `join --dir` registration only.
   Other future duplicate option declarations remain detected by built-CLI startup tests rather
   than by a new static linter.
3. **Level-of-abstraction fit:** Correct layer. The defect is in command registration, so retaining
   the already-existing option and removing its duplicate is preferable to catching the exception
   above Commander or altering command dispatch.
4. **Signal vs authority compliance:** Per
   [`docs/signal-vs-authority.md`](../../docs/signal-vs-authority.md), this has no judgment surface
   and introduces no brittle blocking authority.
5. **Interactions:** The retained `--dir` option still feeds the same `joinMesh` option field, while
   `--port` remains independently registered. There is no shared state, retry, race, or double-fire
   path.
6. **External surfaces:** All CLI commands start again. `instar join --help` exposes one `--dir` and
   one `--port`; no API, persistent-state, operator-action, or external-system contract changes.
   No operator surface is added or modified.
7. **Multi-machine posture:** Replicated as shipped CLI code through the normal package/update path.
   It emits no notices, holds no durable state, and generates no URLs.
8. **Rollback cost:** Pure code change. Reverting reintroduces a deterministic CLI startup crash;
   no data migration or agent-state repair is involved.

**Judgment-point check:** No static heuristic or competing-signals decision point is added.

**Class-closure declaration:** No prompt, hook, config, skill, standards-text, or self-triggered
controller defect is changed; the class-closure declaration is not applicable.

**Conclusion:** The one-line correction is strictly subtractive and restores the command shape main
already intended. The three failure-first built-CLI assertions pass after the change, `join --help`
shows the expected single directory option plus the new port option, and full lint is green.
Second-pass review is not required because no sentinel, gate, messaging, dispatch, session-lifecycle,
or information-flow authority changes.
