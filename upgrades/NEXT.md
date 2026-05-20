# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**fix(boot-wrapper): plist↔wrapper extension drift no longer takes agents dark.**

Three intertwined boot-time changes that together close a "agent goes
silently dark and won't come back" failure mode observed in the field
(Echo, 2026-05-20):

1. **`installBootWrapper()` always writes `instar-boot.cjs`** (not `.js`),
   regardless of the project's `package.json` `"type"` field. `.cjs`
   forces CommonJS semantics in Node, so the wrapper's `require()` calls
   work in both type=module and type=commonjs projects. Previously the
   function picked an extension based on `package.json` AND deleted the
   alt extension — so if a project gained `"type": "module"` after the
   plist was generated (e.g., via a package upgrade), the next call to
   `installBootWrapper` deleted the `.js` file the plist still pointed
   at. launchd then exec'd a nonexistent file on every restart and none
   of the downstream self-heal (`ServerSupervisor.preflightSelfHeal`,
   `NativeModuleHealer`, `INSTAR_SUPERVISED` detection) ever ran because
   the boot wrapper itself never loaded.

2. **`TelegramLifeline.selfHealPlist` adds a wrapper-existence check.**
   The existing three checks all passed when the plist referenced
   `instar-boot.js` but the file was deleted (the plist content still
   matched the legacy-detection patterns). A fourth check now extracts
   the wrapper path from `ProgramArguments` and verifies the file
   exists on disk; if not, the plist is regenerated immediately.
   Defense-in-depth — the always-.cjs change above eliminates the
   creation of this state going forward, but this check rescues any
   already-existing drift before the next launchd restart hits the
   bad path.

3. **`WakeSocketServer.start()` recovers from EADDRINUSE.** The
   pre-existing unlink-before-bind pass handled the common
   "stale socket file from unclean exit" case but silently swallowed
   unlink errors and offered no fallback if `listen()` itself fired
   EADDRINUSE. On EADDRINUSE the server now probes the socket: if a
   live peer answers, surface the error normally (don't clobber a real
   second instance); if nothing answers, force-unlink and retry listen
   once. Bounded retry — single attempt, no churn.

4. **`PostUpdateMigrator.migrateBootWrapperToCjs`** — closes the gap
   for in-the-wild agents whose launchd plists were generated before
   this change with `instar-boot.js` in `ProgramArguments`. On darwin,
   if the plist exists and references `instar-boot.js`, the migration
   regenerates via `installAutoStart` so the plist now points at
   `instar-boot.cjs`. Idempotent — re-runs that find a `.cjs`-referencing
   plist are silent no-ops. The migration does NOT delete the legacy
   `.js` file; rollback safety wins over file cleanup.

Files touched (excluding tests / docs / upgrade notes):
- `src/commands/setup.ts` — `installBootWrapper`, `ensureBootWrapper`
- `src/commands/server.ts` — auto-start plist sanity check accepts `.cjs`
- `src/lifeline/TelegramLifeline.ts` — selfHealPlist 4th check
- `src/threadline/WakeSocketServer.ts` — EADDRINUSE recovery
- `src/core/PostUpdateMigrator.ts` — `migrateBootWrapperToCjs`

## Evidence

**Repro of the original failure** (Echo, 2026-05-20, 10:25 PT):

1. Echo's `package.json` has `"type": "module"` (instar's own package
   has had this since v1.0.0).
2. Earlier `installBootWrapper` calls picked `.cjs`, deleted `.js`, and
   the plist was generated at that point referencing `.cjs`.
3. A subsequent code path (`installBootWrapper` running while the boot
   was actively crashing for a different reason — Node major-version
   ABI break, since rolled back) wrote `.cjs` AGAIN and deleted any
   `.js` that had been re-created by an even-older code path.
4. The plist on disk still referenced `.cjs`, but ALSO any plist that
   had been generated when echo's `package.json` was missing the
   `type: module` declaration referenced `.js` — and the `.js` file
   was gone.
5. launchd's next restart exec'd the nonexistent path → process never
   started → all downstream self-heal (`NativeModuleHealer.healBetterSqlite3`,
   `ServerSupervisor.preflightSelfHeal`, bind-failure escalation)
   silently never ran.
6. Operator intervention (Dawn, manual plist edit) was required to
   restore the agent.

**Observed before:** `git log` shows multiple in-the-wild reports of
launchd plists pointing at a deleted `instar-boot.js` after a project
gained `"type": "module"`. The selfHealPlist check at
`src/lifeline/TelegramLifeline.ts:2076` reads `content.includes('instar-boot.js')`,
which returns `true` even after the file is deleted — so the existing
checks all pass and no regen fires.

**Observed after:**
- New test `tests/unit/boot-wrapper-plist-coherence.test.ts` exercises
  `installBootWrapper` with package.json `type: module`, type: commonjs,
  and no package.json — all three write `instar-boot.cjs`. A test
  explicitly plants a pre-existing `instar-boot.js` and verifies it is
  NOT deleted by the new code path (rollback safety).
- New test `tests/unit/PostUpdateMigrator-bootWrapperCjs.test.ts`
  exercises the four migration branches (non-darwin skip, no plist
  skip, already-.cjs idempotent skip, and the `.js → .cjs` detection +
  regeneration path).
- New test `tests/unit/wake-socket-server-stale-recovery.test.ts`
  exercises the stale-socket cleanup path and asserts that a live peer
  is NOT clobbered (the recovery surfaces EADDRINUSE in that case).
- Existing test suites unchanged; `installBootWrapper` callers in
  `installMacOSLaunchAgent` and `TelegramLifeline.selfHealPlist`
  receive the new `.cjs` path through the unchanged `wrappers.js`
  return field so no callsite needs adjustment.

## What to Tell Your User

- **Your agent stays online through package upgrades**: if I had an
  internal package configuration change, my launchd entry point used
  to risk getting renamed out from under itself. That whole class of
  failure is closed off now — the boot file has a stable name that
  works regardless of internal toggles.
- **Stale socket files don't lock me out anymore**: if I exited
  uncleanly and a leftover socket file blocked the next start, I now
  detect that and clean it up safely, only after first checking that
  nothing else is actually using it.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Plist↔wrapper coherence guarantee | automatic (no action required) |
| selfHealPlist verifies wrapper-path-on-disk | automatic (runs in lifeline boot) |
| WakeSocketServer EADDRINUSE recovery | automatic (runs in listener startup) |
| PostUpdateMigrator regenerates `.js`-plists | automatic on next instar update |
