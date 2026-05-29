# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed **six real-hardware bootstrap defects** that blocked a clean two-machine bring-up — found by driving the live cross-machine seamlessness proof on real hardware (laptop + Mac mini), each verified before fixing and each with a regression test. Spec: `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` (Round 2, approved). Full detail + rollback: `upgrades/side-effects/mm-bootstrap-realhw-fixes.md`.

1. **No-upstream silent push** — `GitSync.commitAndPush` is now upstream-aware (sets `-u origin <branch>` on first push) and surfaces real push failures instead of swallowing them; the connect-to-existing-repo path in `init` also sets push tracking. This closes a bug where the awake machine committed lease epochs locally that *never reached origin*, with zero logs — silently killing all cross-machine sync.
2. **Join scaffolds no config.json** — `instar join` now writes a complete machine-local `config.json` (fresh authToken, port; new `--port` flag) so a joined standby boots authenticated instead of on bare defaults.
3. **Commit-signing broke every commit** — unified the machine signing-key filename on the canonical `signing-key.pem`, and `configureCommitSigning` now test-signs for real and only enables signing if it works (else commits stay unsigned-but-working; verification is a no-op today).
4. **Registry conflict-marker corruption** — `machines/registry.json` was mis-classified (cwd-relative path bug) so the deterministic merge never ran, and clean-exit `--autostash` pop conflicts slipped past the resolver. Both fixed; the registry now auto-merges (union machines, higher-epoch lease wins).
5. **Standby push starvation** — the sync push now rebases-and-retries on a non-fast-forward rejection, so a standby converges within one sync despite the awake machine's lease-renewal churn.
6. **`wakeup --force` propagation** — force-wakeup now claims a real signed +1-epoch lease (not just the local role, which the server would revert) and pushes it, so the takeover reaches the peer.

No agent-installed file template changed, so no migration is required; the fixes ship in the dist and reach existing agents on update.

## What to Tell Your User

- Setting up a second machine for your agent is now actually reliable — the half-dozen ways a fresh two-machine pairing used to silently break (lease never syncing, a joined machine with no auth, commits that all failed, a corrupted machine list) are all fixed.
- This came out of running the real two-machine test end-to-end on your laptop + the Mac mini; every fix is backed by a test that reproduces the exact failure.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable two-machine bring-up | `instar init` → `instar pair` → `instar join <repo> --code <code> [--port N]` |
| `--port` on join | `instar join <repo> --code <code> --port 4061` — pick the joined machine's server port |
| Self-healing registry sync | Automatic — registry conflicts auto-merge (union machines + higher-epoch lease) |
| Robust force-takeover | `instar wakeup --force` now claims + propagates the lease, not just the local role |

## Evidence

- **Six regression tests, all green** (real-git temp repos, no mocks where it matters): `git-sync-push-upstream` (upstream set on first push + push lands), `join-config-scaffold` (authToken always present + port logic), `git-sync-commit-signing` (commit lands whether signing works or is safely disabled — both branches), `git-sync-autostash-registry` (autostash-pop registry conflict resolves to valid JSON with both machines), `git-sync-push-converge` (standby state converges to an ahead remote), `wakeup-force-lease-claim` (force-wakeup writes a self-held +1-epoch lease whose signature verifies).
- **tsc clean; 173 unit tests green** across the new + adjacent GitSync/FileClassifier/machine suites; zero regressions.
- **Live verification:** each defect was first observed on the real two-machine mesh (laptop + mini, Bob untouched) on 2026-05-28, then reproduced in a test, then fixed — verify-before-fix throughout.
