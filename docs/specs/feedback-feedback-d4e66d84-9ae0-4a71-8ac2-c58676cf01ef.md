---
title: Worktree dependency installs cannot empty the agent's shared node_modules
initiative: feedback-d4e66d84-9ae0-4a71-8ac2-c58676cf01ef
cluster: cluster-npm-ci-in-a-worktree-with-a-symlinked-node-modules-empties-t
severity: critical
component: Worktree dependency sharing and guards
---

# Worktree dependency installs cannot empty the agent's shared node_modules

## Problem

`instar worktree create` shares dependencies by making the worktree's
`node_modules` one symlink that points at the instar repo's real
`node_modules` directory, which is the dependency tree the running agent
loads from. Two code paths do this:

- `src/core/InstarWorktreeManager.ts` → `maybeSymlinkNodeModules()` runs
  `fs.symlinkSync(<instarRepo>/node_modules, <worktree>/node_modules)` when
  `shareNodeModules` is on, which is the default.
- `src/templates/scripts/instar-worktree-create.sh` (lines 80–82) runs the
  same `ln -s` in the bash helper.

`npm ci` (and, in some cases, `npm install`, `npm prune` and `npm uninstall`)
clears the existing `node_modules` before it reifies. npm's reify step
follows a top-level `node_modules` symlink and removes the entries inside
the target directory. So running `npm ci` in such a worktree empties the
agent-home `node_modules`. Any process that then loads a module, including
the running agent server, hooks and jobs, fails until the tree is rebuilt.

The only warning at create time is in `src/commands/worktree.ts:122-126`:

> shared node_modules — concurrent 'npm install' in the main checkout may
> mutate this worktree's dependency tree mid-test.

That message covers the opposite direction (main checkout changes the
worktree). It does not say that an install **inside the worktree** destroys
the agent's runtime dependencies. It is printed dim and yellow among other
creation output, and nothing checks it later.

## Evidence

One report (cluster `cluster-npm-ci-in-a-worktree-with-a-symlinked-node-modules-empties-t`,
received 2026-11-02, untrusted reporter text, paraphrased):

- On 2026-11-01 a helper ran `npm ci` in a worktree whose `node_modules` was
  a symlink. The shared agent-home `node_modules` was empty for a few
  minutes.
- The reporter says the create message about shared node_modules is too easy
  to miss, and suggests a guard or a clearer notice.

The code reading above matches the report: the symlink is created
unconditionally by default, and no layer stops a destructive install from
going through it.

## Goals

1. A package-manager operation run inside a worktree cannot remove or
   rewrite files in the agent-home `node_modules`, whether a person or an
   agent runs it, and whether or not hooks are installed.
2. Worktrees still start fast with no network: creation stays a cheap link
   step, not a full install.
3. An agent that really needs private dependencies in a worktree has one
   clear, documented way to get them.

## Non-goals

- Changing how the agent home's own `node_modules` is installed or updated.
- The feedback-factory deps cache (`src/feedback-factory/execute/depsCache.ts`).
  Its links already point at a cache that the confinement policy makes
  read-only.
- `WorktreeManager.fastCopyDeps`, which copies (clonefile/reflink/cp) rather
  than links, so it does not have this problem.

## Proposed fix

There are three layers. Layer 1 is the structural fix. Layers 2 and 3 cover
worktrees created before the fix and give clear remedies.

### Layer 1: shallow link farm instead of a directory symlink (structural)

Replace the single directory symlink with a **real** `node_modules`
directory in the worktree, holding one symlink per top-level entry of the
shared tree:

```
<worktree>/node_modules/            real directory, owned by the worktree
  .bin            -> <instarRepo>/node_modules/.bin
  @scope          -> <instarRepo>/node_modules/@scope
  better-sqlite3  -> <instarRepo>/node_modules/better-sqlite3
  ...
  .instar-shared-deps.json          marker (see below)
```

Why this is safe: when npm (or `rm -rf`) clears a real directory that holds
symlinks, it unlinks the symlinks and does not descend into their targets.
`npm ci` then empties and refills only the worktree's own directory, and the
agent-home tree is untouched. Without any guard, the worst outcome is that
the worktree switches from shared to private dependencies.

Module resolution still works. Node resolves `require('x')` through
`<worktree>/node_modules/x`, follows the link, and by default resolves the
package's own dependencies from its realpath inside the shared tree.
Local tool caches that write into `node_modules` (for example `.vite` and
`.cache`) now land in the worktree's real directory instead of the shared
one. That also fixes the cross-worktree mutation the current warning
describes.

Implementation outline:

- New helper `linkSharedNodeModules(sourceDir, worktreePath)` in
  `InstarWorktreeManager.ts`, replacing `maybeSymlinkNodeModules`:
  - Keep the existing invariants: the source must be a real directory
    (`lstat`) inside the validated repo, and an existing target is never
    overwritten.
  - `mkdir <worktree>/node_modules`, then `symlink` each `readdir` entry of
    the source except `.package-lock.json`. npm treats that file as the
    hidden-lockfile record of the tree. Sharing it through a link would let
    npm rewrite the shared copy, and leaving it out only costs npm a full
    tree read.
  - Write `node_modules/.instar-shared-deps.json` with
    `{ source, sourceSha, createdAt }` so guards and doctors can tell a
    shared tree from a private one.
- Update the bash helper `instar-worktree-create.sh` to do the same thing
  (a `for` loop over the entries). Today it repeats the symlink invariant,
  and the two paths must stay in step.
- Packages added to the shared tree after the worktree was created are not
  visible in the worktree. Mitigation: `instar worktree deps --relink`
  (below) refreshes the farm. The create message says so.

### Layer 2: install guard for already-symlinked worktrees

Worktrees created before Layer 1 still have a directory symlink. Add a
detection rule to the Bash PreToolUse guard
(`src/templates/hooks/dangerous-command-guard.sh`):

- Trigger: the command runs a package-manager install or mutation
  (`npm ci`, `npm install`/`i`, `npm uninstall`/`rm`, `npm prune`,
  `npm update`, `npm dedupe`, `pnpm install`, `yarn install`), **and** the
  effective directory (`cwd`, or the `--prefix` / `-C` / `cd <dir> &&`
  target) has a `node_modules` that is a symlink resolving to a directory
  outside that worktree.
- Action: block at every safety level. This is a catastrophic-class
  operation against the running agent's runtime, not a judgment call. The
  message names the shared target and gives the remedy:
  `instar worktree deps --private` (or `rm node_modules` to unlink only the
  link, then install).
- The rule checks the filesystem, not just a string pattern, so `npm ci`
  in an ordinary checkout is never blocked.

Hooks only protect agent sessions. Layer 1 protects humans and any session
without hooks for every worktree created after the fix. A one-time
migration (below) brings existing worktrees under Layer 1.

### Layer 3: clear notice and a supported escape path

- Replace the create-time warning in `src/commands/worktree.ts` with a
  correct, plain-language notice that is not dimmed:
  "node_modules is linked to the agent's shared dependencies. Running
  npm ci/install here gives this worktree its own private copy and does not
  touch the shared one. To refresh links: `instar worktree deps --relink`."
  (Before Layer 1 ships, the wording must instead warn that an install here
  **would empty the agent's dependencies**.)
- New subcommand `instar worktree deps [--private | --relink | --status]`
  run from inside a worktree:
  - `--status`: reports shared farm, legacy directory symlink, or private.
  - `--private`: replaces a farm or legacy link with an empty real directory
    and prints the install command to run next. It unlinks only and never
    recurses into a symlink target.
  - `--relink`: rebuilds the farm from the current shared tree.
- Migration: on startup, the existing worktree monitor/reaper pass converts
  any agent worktree whose `node_modules` is a legacy directory symlink into
  a link farm. Each conversion is a rename-then-swap with a decision record,
  so it can be undone.

## Test plan

Unit/integration tests (vitest, temp dirs, no network):

1. **Regression test (failing before, passing after):**
   `tests/unit/instar-worktree-shared-node-modules.test.ts` →
   "clearing a worktree's node_modules never removes files from the shared
   agent-home node_modules". Build a temp instar repo with
   `node_modules/pkg-a/index.js` and `node_modules/.bin/x`, create a
   worktree through `createAgentWorktree`, then run the clearing step npm
   performs: `fs.rmSync(<worktree>/node_modules/<each entry>, {recursive:
   true, force: true})` for every `readdir` entry, plus a real `npm ci
   --offline` against an empty-dependency lockfile where npm is available.
   Assert that the shared `pkg-a/index.js` and `.bin/x` still exist. Today
   this fails because the entries are read through the directory symlink.
2. The farm resolves modules: `require.resolve('pkg-a', { paths:
   [worktree] })` succeeds and realpaths into the shared tree.
3. The source invariants still hold: a symlinked source is refused, and an
   existing target is left alone.
4. The bash helper and the TypeScript manager produce the same layout
   (parity test running the script in a temp repo).
5. Guard: a legacy directory symlink plus `npm ci` is blocked with the
   remedy text. A real `node_modules` plus `npm ci` passes. A farm plus
   `npm ci` passes.
6. `worktree deps --private` on a legacy link unlinks it and leaves the
   shared tree byte-identical (compare file lists before and after).

## Rollout and risk

- Layer 1 changes the on-disk layout only for newly created worktrees. The
  migration for existing worktrees ships behind a config flag
  (`worktree.migrateSharedNodeModules`, default on after one release).
- Risk: tools that treat a top-level symlinked package differently. pnpm-style
  layouts already use per-package symlinks in the npm ecosystem, and vitest,
  tsc and husky handle them. The test suite run inside a farm worktree is
  the acceptance check.
- Risk: the farm hides packages added to the shared tree later. This is
  limited by `--relink` and by the notice. The failure is a clear
  "module not found" inside the worktree, never a change to the agent's
  runtime.

## Open questions

- Should Layer 2 also run as an npm `preinstall`-independent check in the
  husky/CLI path? (`npm ci` deletes the tree before lifecycle scripts run,
  so `preinstall` is too late and is not an option.)
- Should the health watchdog also alert when the agent-home `node_modules`
  suddenly loses most of its entries, as a backstop for causes other than
  worktrees?
