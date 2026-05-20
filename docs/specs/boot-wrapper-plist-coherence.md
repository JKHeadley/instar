---
title: Boot-wrapper / plist coherence — close the "agent goes dark" failure class
date: 2026-05-20
author: echo
review-convergence: tactical-hotfix-2026-05-20
approved: true
approved-by: Justin
approved-via: Telegram topic 11013 ("Lets proceed with whatever we need to get these cirtical issues fixed! They are shutting down instar agents in the wild" at 2026-05-20 18:30 UTC)
eli16-overview: boot-wrapper-plist-coherence.eli16.md
---

# Spec — Boot-wrapper / plist coherence

**Date:** 2026-05-20
**Author:** echo
**Status:** in-flight (approved 2026-05-20 in topic 11013)
**Triggering incident:** echo went dark, ~10:25 PT, manual operator intervention required.

## Background

At ~10:25 PT 2026-05-20, the `echo` agent crash-looped and stopped
responding. Manual operator intervention was required to bring it back:
revert `.instar/bin/node`, rebuild `better-sqlite3`, remove a stale
`listener.sock`, regenerate the `instar-boot.cjs` wrapper via
`installBootWrapper()`, and edit the launchd plist to reference `.cjs`
instead of the deleted `.js`.

Root-cause analysis identified ONE blocking failure + several adjacent
issues:

1. **BLOCKING — Plist↔wrapper extension drift.** `installBootWrapper()`
   picked the wrapper extension (`.js` vs `.cjs`) based on the project's
   `package.json "type"` field and DELETED the alt extension. If a
   project gained `"type": "module"` after the plist was generated, the
   next call to `installBootWrapper()` deleted the `.js` file the plist
   still pointed at. launchd then exec'd a nonexistent file on every
   restart and none of the downstream self-heal ran (the wrapper itself
   never loaded).

2. **DOWNSTREAM (already mitigated) — Node major-version ABI break.**
   Homebrew updated `/opt/homebrew/bin/node` from 22.x to 25.x; the
   `.instar/bin/node` symlink's TARGET STRING was unchanged but what it
   resolved to flipped major versions. `better-sqlite3` (compiled for
   ABI 127) failed to load on ABI 128. `ServerSupervisor.preflightSelfHeal`
   already rebuilds on detection, BUT only if the boot wrapper loads —
   blocked by failure #1.

3. **DOWNSTREAM (partially mitigated) — Stale listener.sock.**
   `WakeSocketServer.start()` pre-bind-unlinked but silently swallowed
   errors and provided no fallback if `listen()` itself fired EADDRINUSE.
   The pre-bind unlink ALSO clobbered live peers' sockets (silently
   stealing the path), which is incorrect but only manifests in
   multi-instance scenarios.

4. **DOWNSTREAM — Plist ownership split.** Same family as #1 — the
   plist's `ProgramArguments` and the wrapper file on disk are written
   by different code paths and can drift if one runs without the other.

## Goal

Make the **plist↔wrapper coherence class** of failure structurally
impossible. After this change ships, an agent whose project gains
`"type": "module"` (or loses it) cannot end up with a plist pointing at
a deleted wrapper file.

Adjacent fixes for #3 and #4 land in the same PR because they are
tightly intertwined with the wrapper-generation layer and tested
together. #2 is OUT OF SCOPE — already mitigated by the existing
`NativeModuleHealer` + `ServerSupervisor` preflight + `DegradationReporter`
bridge (PR #281).

## Scope (must-haves)

### Change 1 — `installBootWrapper()` always writes `.cjs`

**File:** `src/commands/setup.ts` (function `installBootWrapper`)

Replace:

```ts
let usesCjs = false;
try {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
  usesCjs = pkgJson.type === 'module';
} catch { /* no package.json or parse error — use .js */ }
const jsExt = usesCjs ? '.cjs' : '.js';
const jsPath = path.join(stateDir, `instar-boot${jsExt}`);
const altPath = path.join(stateDir, `instar-boot${usesCjs ? '.js' : '.cjs'}`);
try { SafeFsExecutor.safeUnlinkSync(altPath, { operation: '...' }); } catch { }
```

With:

```ts
const jsPath = path.join(stateDir, 'instar-boot.cjs');
```

Rationale: `.cjs` forces CommonJS regardless of parent `package.json
"type"`, so the wrapper's `require()` calls work in both type=module and
type=commonjs projects. Eliminating the extension-flip eliminates the
drift class. Eliminating the alt-extension delete eliminates the
file-disappears-under-the-plist failure mode.

The `js` field name on the return value is preserved for caller compat
(every caller treats it as an opaque path).

### Change 2 — `ensureBootWrapper()` looks for `.cjs`

**File:** `src/commands/setup.ts` (function `ensureBootWrapper`)

Same hardcode: always look for `instar-boot.cjs`. Triggers regeneration
when missing, which writes the current always-`.cjs` content.

### Change 3 — `TelegramLifeline.selfHealPlist` adds wrapper-existence check

**File:** `src/lifeline/TelegramLifeline.ts` (method `selfHealPlist`)

The pre-existing three checks all PASSED for the failure shape echo hit:

- Check 1: plist mentions `instar-boot.js` or `instar-boot.cjs` →
  string match passes for the deleted-file case.
- Check 2: plist references `.instar/bin/node` → passes.
- Check 3: node binary at the plist path exists → passes.

Add Check 4: extract the wrapper path from `ProgramArguments` and
verify the file exists on disk. If not, regenerate via `installAutoStart`.

### Change 4 — `WakeSocketServer.start()` probe-before-clobber

**File:** `src/threadline/WakeSocketServer.ts`

Replace pre-bind unconditional unlink with: listen()-first, then on
EADDRINUSE probe-connect to determine if a live peer is bound. If yes,
emit error (don't unlink). If no, unlink and retry listen() once.
ENOENT during retry-unlink is non-fatal (the file is already gone).
Listener attached once; detached on first EADDRINUSE so close-emitted
errors don't re-trigger the retry path.

### Change 5 — `PostUpdateMigrator.migrateBootWrapperToCjs`

**File:** `src/core/PostUpdateMigrator.ts`

New migration. On darwin only. If `~/Library/LaunchAgents/ai.instar.<projectName>.plist`
references `instar-boot.js`, regenerate via `installAutoStart` (which
writes the new `.cjs` wrapper and updates plist `ProgramArguments`).
Idempotent. Does NOT delete the legacy `.js` file (rollback-safe).

## Non-goals

- Not changing `NativeModuleHealer`, `ServerSupervisor.preflightSelfHeal`,
  or any other piece of the existing native-module heal infrastructure.
  Those work correctly when the boot wrapper can load; this PR makes
  sure the boot wrapper CAN load.
- Not changing the wrapper script content (the JS body that handles
  shadow-install resolution + crash-loop detection + node symlink heal
  was correct as of PR #91 + subsequent hardening PRs).
- Not touching the listener daemon's protocol or message routing —
  only the socket-bind recovery sequence in `WakeSocketServer.start()`.
- Not adding a Remediator-level runbook for this failure. The fix is
  surface-level (always-`.cjs` eliminates the drift class), not
  Remediator-orchestrated.

## Acceptance criteria

1. **Repro of the echo failure mode.**
   Test plants pre-existing `instar-boot.js` + `package.json "type":
   "module"`, runs `installBootWrapper`, asserts `.js` file NOT deleted.
   Pre-change: file deleted. Post-change: file preserved.

2. **selfHealPlist Check 4 catches drift.**
   Implementation-asserted via the new logic at
   `src/lifeline/TelegramLifeline.ts:selfHealPlist`. Extracts the
   wrapper path from `<string>...instar-boot.(cjs|js)</string>` and
   verifies on disk.

3. **Migrator handles existing `.js`-referencing plists.**
   Unit test plants a plist referencing `instar-boot.js`, runs the
   migrator, asserts the migrator either marks `upgraded` or `errors`
   — both prove the detection-and-regeneration path ran.

4. **WakeSocketServer does NOT clobber live peers.**
   Unit test binds a real `net.Server` to the socket, attempts to start
   a second `WakeSocketServer`, asserts the second emits EADDRINUSE
   without unlinking the first's socket.

5. **WakeSocketServer recovers from stale socket.**
   Unit test plants an empty file at the socket path, starts the
   server, asserts listen succeeds.

## Signal-vs-authority compliance

- `installBootWrapper` (always-cjs) — authority, deterministic, no
  judgment.
- `ensureBootWrapper` — signal (returns boolean); caller decides.
- `selfHealPlist` Check 4 — authority (regenerates), but the trigger
  (file existence) is structural.
- `migrateBootWrapperToCjs` — authority (regenerates), structural
  detection.
- `WakeSocketServer` probe-then-recover — bounded recovery primitive
  (single retry, hard timeout, no judgment call).

Per `docs/signal-vs-authority.md`: signals are structural; the new
authorities are bounded recovery, not judgmental gates.

## Rollback

Pure code change. `git revert` works without persistent-state cleanup.
Agents whose plists were already migrated to `.cjs` continue to work
post-revert (the post-revert `installBootWrapper` writes whichever
extension package.json implied, but the existing `.cjs` plist still
loads). Agents not yet migrated continue on `.js` — unchanged. No
data migration to undo.
