# Side-effects — node_modules Spotlight exclusion

## 1. What files/state does this touch at runtime?
Drops one empty `.metadata_never_index` file into `<agentHome>/node_modules` and
`<stateDir>/shadow-install/node_modules` (if they exist) during the PostUpdateMigrator pass.
No other files, no config keys, no schema.

## 2. Does it change any functional behavior?
No. `.metadata_never_index` is a macOS Spotlight hint only — it has zero effect on file access,
Node module resolution, builds, or any instar logic. It just tells Spotlight not to index the
folder (which is correct — node_modules is never searched).

## 3. What happens on failure / unwritable path / non-macOS?
Best-effort: the shared helper swallows write failures (`@silent-fallback-ok`) and returns
false, so the migration never errors or blocks on it. On non-macOS the file is inert.

## 4. Migration parity — do existing agents get it?
Yes — it's a PostUpdateMigrator pass that runs on every update, so existing agents are
backfilled on their next update. Idempotent (present marker → no-op, no re-report). New agents'
node_modules get marked the first time the migrator runs post-init.

## 5. Could it spam / flood / burn resources?
The opposite — it REDUCES resource use (stops Spotlight re-indexing ~20GB of node_modules
fleet-wide). The migration itself does at most two `existsSync` + two `writeFileSync` per agent
per update. No loop, no network, no process spawn.

## 6. Rollback / off-switch?
Reverting the PR stops new markers being added; existing markers are harmless and can be left
(or removed with `find ... -name .metadata_never_index -delete` to re-enable indexing). No
residual state, no flag needed.

## 7. Concurrency / ordering?
None — runs inline in the single-threaded migration sequence after the worktree exclusion.

## Blast radius
Minimal + additive. One new PostUpdateMigrator method + its run() wiring + test coverage.
Mirrors the already-shipped worktree exclusion. No change to any route, sentinel, schema, or
decision path. Pure OS-hygiene win addressing the measured top idle-CPU source.
