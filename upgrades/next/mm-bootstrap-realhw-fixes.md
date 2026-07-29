## What Changed

Fixes from a real two-machine bring-up (laptop + Mac mini), rebased onto current main in July. Spec:
`docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`. Full detail, including what main had already
solved, is in `upgrades/side-effects/mm-bootstrap-realhw-fixes.md`.

**The load-bearing fix — a freshly-joined machine could take a live machine's lease.** A machine that
has just joined boots from a copied repository, and that copy carries the lease holder's *last-seen*
timestamp from whenever the copy was made. The new machine read that stale timestamp as "the holder
has not checked in, it must be dead" and claimed the lease while the holder was still working. The
lease view is now primed from the durable medium BEFORE the failover-eligibility decision, so the
check sees the holder's current heartbeat rather than a seed value.

Also included, from the same bring-up: `instar join` now scaffolds a complete machine-local
`config.json` (fresh authToken, port, and a new `--port` flag) so a joined standby boots
authenticated; the machines registry auto-merges instead of corrupting on a conflict (it was
mis-classified by a cwd-relative path bug, so the deterministic merge never ran); and
`wakeup --force` claims and propagates a real signed +1-epoch lease rather than only flipping the
local role, which the server used to revert.

Three filename/default-level rewrites from the original set are NOT here because main solved them
first, in better form: the upstream-aware push, the signing-key filename-only change, and the
exactly-once-ingress default. The GitSync signing viability probe is present: it retains main's
canonical + legacy lookup and enables signing only after a real sign succeeds. See the side-effects
addendum for each.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A joined machine no longer steals a live lease | Automatic on join |
| `--port` on join | `instar join <repo> --code <code> --port 4061` |
| Self-healing registry sync | Automatic — registry conflicts auto-merge (union machines, higher-epoch lease wins) |
| Robust force-takeover | `instar wakeup --force` now claims and propagates the lease |

## What to Tell Your User

Setting up a second machine for your agent is more reliable. In particular, a machine you have just
added will no longer decide that your working machine is dead and take over from it — which is the
failure that produces two machines both believing they are in charge.

## Evidence

Regression tests, all green against real git temp repos: `lease-fresh-join-prime` (the priming fix),
`join-config-scaffold`, `git-sync-autostash-registry`, `wakeup-force-lease-claim`,
`git-sync-push-converge`, `git-sync-commit-signing`. Type-check clean. Each defect was first observed
on the real two-machine mesh on 2026-05-28, then reproduced in a test, then fixed.

On the July rebase: the four superseded/partial items were dropped rather than reapplied; 187 related
GitSync, lease, coordinator, join, wakeup, and multi-machine unit/e2e tests pass. The built CLI also
starts cleanly with exactly one `join --dir` option and the new `join --port` option.
