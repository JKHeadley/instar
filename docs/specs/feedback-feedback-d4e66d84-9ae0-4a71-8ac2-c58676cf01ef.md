---
title: Worktree dependencies are private copies, never a link into the agent's runtime tree
status: draft
created: 2026-11-09
owner: echo
initiative: feedback-d4e66d84-9ae0-4a71-8ac2-c58676cf01ef
cluster: cluster-npm-ci-in-a-worktree-with-a-symlinked-node-modules-empties-t
severity: critical
component: Worktree dependency sharing and guards
---

# Worktree dependencies are private copies, never a link into the agent's runtime tree

## Problem

`instar worktree create` (`src/core/InstarWorktreeManager.ts`, `maybeSymlinkNodeModules`) and
the bash helper template (`src/templates/scripts/instar-worktree-create.sh`, lines 80–82) make
`<worktree>/node_modules` a **symlink to `<instarRepo>/node_modules`**. On an agent like Echo
that directory is the dependency tree the running agent loads.

Because it is a link, every package operation run in the worktree writes to the agent's
runtime tree:

- `npm ci` deletes `node_modules` before installing. npm follows the link and empties the
  agent's directory. The agent runs without dependencies until the install finishes, and
  keeps a broken tree if the install fails.
- `npm install <pkg>`, `npm uninstall`, `npm rebuild`, `npm dedupe` and `npm prune` change
  the agent's tree to match the **worktree's** `package.json` and lockfile, which may be a
  different branch.
- Install lifecycle scripts (`preinstall`, `postinstall`, `prepare`) and tools that write
  into `node_modules/.cache`, `node_modules/.vite` or `node_modules/.bin` write into the
  agent's tree too.

The only defence today is a yellow line printed by `src/commands/worktree.ts` (line ~123). It
warns about the opposite direction (main checkout changing the worktree) and says nothing
about `npm ci`.

## Evidence

- Reporter text (untrusted, paraphrased): on 2026-11-01 a helper ran `npm ci` in a worktree
  whose `node_modules` was a symlink. That emptied the shared agent-home `node_modules` for a
  few minutes. The create-time notice was easy to miss.
- Code: `maybeSymlinkNodeModules` calls `fs.symlinkSync(source, target)` with
  `shareNodeModules` defaulting to `true`. The bash template does the same with `ln -s`.
- Contrast: `src/core/WorktreeManager.ts` `fastCopyDeps` already avoids this. It makes a
  copy-on-write **clone** (`cp -c -R` on APFS, `cp -R --reflink=auto` on btrfs/xfs, a plain
  copy otherwise, and never `cp -al`). The code comment there says "writes diverge". The
  agent-worktree path never adopted this approach.

## Why the previous design was rejected (and what this one does differently)

The previous draft linked each top-level entry of `node_modules` separately and added a
`dangerous-command-guard.sh` rule. An independent review found three problems:

1. Linked `@scope` folders, `.bin` and any existing `.cache`/`.vite` were still shared, so
   writes through them still reached the agent's tree.
2. The design needed hook edits, which this work may not make.
3. The tests did not cover writes through scoped packages, `.bin`, caches or lifecycle
   scripts.

This design **removes every link from the worktree into the agent's tree**. No directory the
worktree can write to resolves into `<instarRepo>/node_modules`, at any depth. So there is
nothing a guard needs to catch, and no hook changes. Safety comes from the filesystem layout,
not from intercepting commands ("Structure beats Willpower").

## Proposed fix

### 1. Private dependency tree at create time (core)

Replace `maybeSymlinkNodeModules` with `provisionPrivateNodeModules(instarRepo, worktreePath)`
in a new module `src/core/worktreeDeps.ts`. `WorktreeManager.fastCopyDeps` should call the same
module so there is one implementation.

- Source: `<instarRepo>/node_modules`. Use it only if `lstat` says it is a real directory, not
  a symlink (same rule as today).
- Target: `<worktree>/node_modules`. Do nothing if it already exists.
- Strategy, in order:
  1. **CoW clone** into a sibling temp dir `<worktree>/.node_modules.provisioning-<pid>`:
     `cp -c -R` on darwin/APFS, `cp -R --reflink=always` on Linux. On APFS a clone is
     sub-second and uses almost no extra space until a file is written.
  2. When CoW is unavailable, do **not** fall back to a full copy (too slow and large for an
     agent's many worktrees) or a link. Leave the worktree with no `node_modules` and report
     `deps: none — run 'npm ci' in the worktree` (this is now always safe, see §3).
  3. `cp` must not follow symlinks inside the tree, so `.bin` entries stay relative links
     inside the clone. The provisioner checks this: after cloning it walks the clone's
     symlinks (top level, `@scope/*`, `.bin/*`, and nested `node_modules` up to the depth npm
     produces). Any link whose `realpath` is inside `<instarRepo>/node_modules` but not inside
     the clone makes provisioning fail. The temp dir is removed and the step-2 result is
     reported.
- Drop caches from the clone: remove `<clone>/.cache`, `<clone>/.vite` and
  `<clone>/.package-lock.json`. The worktree's tools rebuild their own caches, and the
  hidden lockfile is rewritten by npm from the worktree's tree.
- Write a marker `<clone>/.instar-private-deps.json` with `{ source, clonedAt, strategy }`.
- Atomically `rename` the temp dir to `<worktree>/node_modules`.
- The ledger entry and `CreateWorktreeResult` replace `shareNodeModules: boolean` with
  `deps: 'private-clone' | 'none'`. `shareNodeModules` is still accepted as an input alias:
  `false` maps to `none` and `true` maps to the default. A link is never produced.

Husky ordering: `ensureHuskyHooksActive` needs the `husky` binary. When the result is `none`,
run the prepare step with the agent's binary by absolute path
(`<instarRepo>/node_modules/.bin/husky`), cwd set to the worktree. Husky writes only
`<worktree>/.husky/_` and the worktree's git config. It does not write to `node_modules`.

### 2. Bash helper template

In `src/templates/scripts/instar-worktree-create.sh`, replace the `ln -s` block with a CoW
clone (`cp -c -R` on darwin, `cp -R --reflink=always` elsewhere) into a temp dir followed by
`mv`. If the clone fails, print `run 'npm ci' in the worktree`. This file is a template script,
not a hook. If changing it is out of bounds for the implementing PR, the alternative is to
delete those three lines so the helper creates no `node_modules`. Either way, the helper stops
producing a link.

### 3. Existing worktrees that still have the link

Worktrees created before this fix keep their symlink, so the hazard remains until they are
fixed.

- New subcommand `instar worktree deps --privatize [<path>|--all]`. For each agent worktree
  whose `node_modules` is a symlink resolving to `<instarRepo>/node_modules`, it clones as in
  §1 into a temp dir and `rename`s it over the link. On POSIX, `rename` replaces the link
  itself and never touches its target. It never calls `rm -rf` on a link, so the target is
  never followed.
- `instar worktree list` and the existing worktree detector (`AgentWorktreeDetector`) report
  `shared-deps-link` as an attention item with the one-line fix command. No hook involved.
- A `PostUpdateMigrator` step runs `--privatize --all` once after upgrade (opt-out flag in
  config). Worktrees where the clone fails get the link removed with `fs.unlinkSync`, which
  only removes the link, and the "run npm ci" notice.

### 4. Disk steward compatibility

`src/monitoring/agentWorktreeGit.ts` classifies a real `node_modules` directory as `work`, so
private clones would stop merged worktrees from being reaped. Extend the classifier so a
`node_modules` directory holding a valid `.instar-private-deps.json` marker is `regenerable`.
Removing it is safe because it is a private copy that nothing else links into. Without the
marker, keep today's behaviour.

### 5. Notice

Replace the yellow line in `src/commands/worktree.ts` with
`deps: private copy (clone) — npm ci/install here cannot affect the running agent` or
`deps: none — run 'npm ci' in the worktree before building/testing`.

## Non-goals

- No change to `dangerous-command-guard.sh` or any other hook, and no command interception.
- No change to the feedback-factory `depsCache`. Its session links go to a separate per-lockfile
  cache that the confinement policy already makes read-only, not the agent's runtime tree.
- No change to how the agent's own `node_modules` is installed.

## Test plan (regression tests, written to fail on today's code)

New file `tests/unit/worktreeDeps-isolation.test.ts`. Each test builds a disposable fake
"agent repo" in a temp dir. Its `node_modules` contains: a plain package `a/`, a scoped
package `@s/b/`, `.bin/a` (a relative link to `../a/cli.js`), an existing `.cache/x` and
`.vite/y`, and a nested `a/node_modules/c/`. The tests provision a worktree through the real
`provisionPrivateNodeModules` (CoW is forced through an injectable `cp` strategy so the tests
run on any filesystem). Each test checks that a recursive content+inode snapshot of the agent's
`node_modules` is byte-identical before and after.

1. **`npm ci` style wipe**: `fs.rmSync(<wt>/node_modules, {recursive:true})`, then
   recreate. The agent snapshot is unchanged. This is the reported failure: on today's code the
   symlink makes the agent tree empty.
2. **Real `npm ci`** (gated on `npm` being present, offline, with an empty
   `package.json`/lockfile and `--ignore-scripts=false`). The agent snapshot is unchanged.
3. **Scoped write**: write `<wt>/node_modules/@s/b/new.js` and delete
   `<wt>/node_modules/@s/b/index.js`. The agent snapshot is unchanged.
4. **`.bin` write**: replace `<wt>/node_modules/.bin/a` with a file and add `.bin/z`. The
   agent snapshot is unchanged, and `.bin/a` in the clone was a link inside the clone, not
   into the agent tree.
5. **Caches**: `<wt>/node_modules/.cache` and `.vite` do not exist after provisioning.
   Writing new ones leaves the agent snapshot unchanged.
6. **Lifecycle script**: a local file-dependency package with a `postinstall` that writes to
   `$INIT_CWD/node_modules/.postinstall-ran` and to `../../a/touched` (relative to its own
   install dir). `npm install` in the worktree, gated on `npm`. The agent snapshot is unchanged.
7. **Nested**: write `<wt>/node_modules/a/node_modules/c/x`. The agent snapshot is unchanged.
8. **Escape detection**: plant an absolute link in the source tree
   (`node_modules/@s/evil -> <agent>/node_modules/a`). Provisioning refuses and reports `none`,
   no partial temp dir is left behind, and nothing is linked.
9. **No CoW**: the strategy reports unsupported. The result is `none`, there is no
   `node_modules` in the worktree, and it is not a link.
10. **Privatize migration**: start with today's symlink layout, run `--privatize`. The worktree
    `node_modules` is now a real directory with the marker, and the agent snapshot is
    unchanged. Repeat with a failing clone: the link is gone and the target is intact.
11. **Create path**: `createAgentWorktree` (existing harness in
    `tests/unit/InstarWorktreeManager.test.ts`) never produces
    `lstat(<wt>/node_modules).isSymbolicLink()`, with `shareNodeModules` unset, true or false.
12. **Disk steward**: a merged worktree whose `node_modules` holds the marker is classified
    `regenerable`. Without the marker it stays `work`.

## Rollout

Ship §1, §2, §5 and the tests together. Ship §3 and §4 in the same PR, because without §3 the
existing linked worktrees keep the hazard, and without §4 private clones would build up on
disk. The change is not dev-gated: the old behaviour is the critical hazard.
