# Files Tab Never Serves Key Material

<!-- bump: patch -->

## What Changed

The dashboard file routes (`/api/files/read`, `/download`, `/list`, `/link`) now refuse every
key-bearing file under `.instar/` — the agent identity and its superseded/invalid/temp
siblings, the threadline HMAC/invitation/token files, the dedicated SSH keys, the headless key
vault, origin-session credentials, the inbound-delivery and conversation-bind secrets, the
manifest signing key, the machine key pair, the remediation key vault and the telemetry secret — by a code-owned list the config cannot loosen.
The check runs on the requested path, the resolved path AND the opened descriptor (device +
inode), so a symlink swapped between the check and the read, a symlink with an innocent name,
or a hard link outside `.instar/` (static key names, the generation-named SSH keys and the origin-session files alike) no longer reaches the bytes; `list` omits such entries. The
same list now feeds the backup exclusions, the gitignore entries written at init and by the
post-update migration (both repos), and the git-sync secret classifier, so the four surfaces
cannot drift apart. The standalone init path also now writes its multi-machine gitignore
entries into the project `.gitignore` (they were landing in `.instar/.gitignore`, where they
matched nothing).

## What to Tell Your User

The Files tab in the dashboard no longer shows, reads, downloads or links the files that hold
my private keys and secrets, and they are never included in a backup or synced to another
machine. If you see a 403 on one of those files, that is the floor working, not a bug: move
the document you wanted somewhere else; I never serve the key.

## Summary of New Capabilities

- Key material is refused by path, by resolved path and by the opened file's identity in all
  four file routes; a listing hides it instead of naming it.
- One shared list drives the file routes, backups, gitignore and the sync classifier.
- A behavioural test boots a real agent home, pairs it, and walks `.instar/` for anything that
  looks like a key; a key file the list misses fails the build.

## Evidence

Unit (`tests/unit/file-routes-never-served-key-material.test.ts`), integration walk
(`tests/integration/file-routes-never-served-walk.test.ts`, real init + real pairing +
every in-tree key producer, 7 tests) and E2E production-boot + migration idempotency
(`tests/e2e/files-never-serve-key-material-alive.test.ts`) are green; the existing
file-route, backup, classifier and gitignore-migration suites re-run green (271 tests).
