# Side-Effects Review — Boot-Wrapper / Plist Coherence

**Version / slug:** `boot-wrapper-plist-coherence`
**Date:** `2026-05-20`
**Author:** Echo (instar developer agent)
**Trigger:** Field failure 2026-05-20, ~10:25 PT: instar agent "echo"
went dark, required operator intervention (Dawn — manual plist edit) to
recover. Root cause: launchd plist's `ProgramArguments` referenced
`instar-boot.js` but that file had been deleted by `installBootWrapper`
because `package.json` had gained `"type": "module"`.

## Summary of the change

Four interlocking edits that together eliminate the plist↔wrapper
extension-drift failure class:

1. **`installBootWrapper()` always writes `.cjs`.** No more reading
   `package.json "type"` and switching extensions. No more deleting the
   alt extension.
2. **`ensureBootWrapper()` looks for `.cjs`.** The presence check used
   to look for the type-dependent extension; now it always looks for
   `.cjs`.
3. **`TelegramLifeline.selfHealPlist` adds Check 4:** verify the wrapper
   path referenced by the plist's `ProgramArguments` exists on disk. If
   not, regenerate via `installAutoStart`. Defense-in-depth for any
   already-drifted state.
4. **`PostUpdateMigrator.migrateBootWrapperToCjs`** detects existing
   `.js`-referencing plists and regenerates them to point at `.cjs` via
   `installAutoStart`. Idempotent.
5. **`WakeSocketServer.start()`** uses a probe-before-clobber pattern.
   Previously: pre-bind unconditional `unlink`. New: listen first; on
   EADDRINUSE, probe-connect to determine if the socket is live or
   stale; only unlink+retry if confirmed stale. Prevents silently
   stealing a path from a live peer.

## Decision matrix

### Over-block

| Scenario | Outcome |
|----------|---------|
| Project has package.json `"type": "module"` | Always-`.cjs` is correct (no behavioral change vs. pre-existing `.cjs`-write path) |
| Project has no package.json | Always-`.cjs` works (Node treats `.cjs` as CommonJS regardless of parent context) |
| Project has package.json `"type": "commonjs"` | Always-`.cjs` works (CommonJS is the explicit context) |
| Existing `.js` wrapper on disk | NOT touched (rollback-safe — old plists referencing `.js` keep working until migrator runs) |
| Existing `.cjs` wrapper on disk | Overwritten with current content (preserves existing behavior) |

No over-block. The `.cjs` extension is strictly broader than the previous `.js`+`.cjs` split.

### Under-block

| Scenario | Outcome |
|----------|---------|
| Plist references `.js`, no `.js` file on disk, no `.cjs` file on disk | Migrator regenerates; selfHealPlist Check 4 catches | 
| Plist references `.cjs`, `.cjs` file deleted | selfHealPlist Check 4 catches (regenerates) |
| Plist references `.js`, `.js` file present, `.cjs` file present | Migrator regenerates plist to `.cjs` (idempotent on re-run) |
| Plist references `.js`, `.js` file present, `.cjs` file missing | Migrator regenerates plist (writes `.cjs` + updates plist) |

No under-block.

### Level of abstraction fit

- The fix lives at the WRAPPER GENERATION + WRAPPER VERIFICATION layer,
  which is the same layer where the bug originated. Not pushed up into
  the Remediator (out of scope for this PR — Remediator is still under
  Tier 2 rollout per the v3 spec) and not pushed down into launchd (no
  way to influence launchd's interpretation of the plist).
- `installBootWrapper`'s contract is unchanged from a caller's
  perspective: it still returns `{ sh, js }`. The `js` field name is now
  a slight misnomer (the file is `.cjs`) but every existing caller uses
  it as an opaque path string, so no callsite changes.

### Signal-vs-authority compliance

| Component | Signal or Authority | Reason |
|-----------|--------------------|--------|
| `installBootWrapper` always-`.cjs` | Authority (writes files) | Deterministic, content-based decision. No judgment call. |
| `ensureBootWrapper` `.cjs` lookup | Signal (returns boolean) | Caller decides what to do with "wrappers missing". |
| `selfHealPlist` Check 4 | Authority (writes files via installAutoStart) | Existence check is deterministic. The regeneration is a documented recovery primitive. |
| `migrateBootWrapperToCjs` | Authority (writes files via installAutoStart) | Detection is structural (plist content matches regex). Regeneration is the same primitive other migrations use. |
| `WakeSocketServer` probe-then-recover | Signal-and-Authority hybrid | Probe is a signal (connect-or-not); the unlink+retry is bounded recovery (single retry, hard timeout). |

Compliant. The new authorities are bounded recovery primitives, not
judgmental gates. The new signals are deterministic structural checks.

### Interactions with adjacent systems

| System | Interaction | Risk |
|--------|-------------|------|
| `NativeModuleHealer` | None direct. NativeModuleHealer fires after boot wrapper loads; this fix ensures the boot wrapper CAN load. | Strictly improves NativeModuleHealer's blast radius. |
| `ServerSupervisor.preflightSelfHeal` | None direct. Preflight runs after boot wrapper spawns the lifeline. | Same — strictly improves preflight's coverage. |
| `detectLaunchdSupervised` | None. Runs inside the lifeline; the fix is upstream. | None. |
| `INSTAR_SUPERVISED` plist env | Compatible — `installMacOSLaunchAgent` regenerates the full plist including this env var. | None. |
| `RestartOrchestrator` | Same as above — fix is upstream. | None. |
| `DegradationReporter` | None direct. Migrator failures land in `result.errors[]` which feed the migration report, not Degradation. Acceptable: migrator runs in a known supervised window, not in production hot paths. | None. |
| `WakeSocketServer` listener daemon usage | The probe-before-clobber change only fires on EADDRINUSE. Normal startup path (no stale file) is unchanged. | Tested with planted-stale-file + live-peer scenarios. |
| Existing `.js`-wrapper-using agents | Continue to work — `.js` file is NOT deleted; old plists still load; migrator regenerates plist on next update. | Backward compatible by design. |
| Tests that simulate `instar-boot.js` (e2e/launchd-*) | These tests generate their OWN `.js` wrappers and do NOT go through `installBootWrapper`. Unchanged. | None — verified by reading the test files. |

### Rollback cost

- Pure code change. Revert is one git revert per affected file.
- No persistent state changes that block rollback. The migrator runs
  forward-only; rolling back leaves agents on `.cjs` plists (which work
  fine) — the old `.js` files are still around if needed.
- `WakeSocketServer` change: revert restores pre-bind-unlink behavior.
  The live-peer-clobber behavior re-emerges but is rare in practice
  (single-tenant agents on a machine).
- Migrator runs idempotently — rolling back and re-deploying produces
  the same end state.

## Acceptance criteria

1. **Repro of the Echo failure mode.**
   - Test: `tests/unit/boot-wrapper-plist-coherence.test.ts > installBootWrapper — always writes .cjs > does NOT delete a pre-existing instar-boot.js (rollback safety)`
   - Plants a pre-existing `instar-boot.js`, runs `installBootWrapper` with `package.json type=module`. Asserts the `.js` file still exists. Pre-change behavior: file deleted. Post-change: file preserved.

2. **selfHealPlist catches drift.**
   - Implicit in `TelegramLifeline.ts` source: `Check 4` extracts the wrapper path from `ProgramArguments` and verifies `fs.existsSync`. Covered by `Check 4` logic.

3. **Migrator handles existing `.js`-referencing plists.**
   - Test: `tests/unit/PostUpdateMigrator-bootWrapperCjs.test.ts > detects a plist that references instar-boot.js and attempts regeneration`
   - Plants a plist referencing `instar-boot.js`. Runs the migrator. Asserts the migrator either succeeds (`upgraded`) or surfaces an error (`errors`) — both prove the detection-and-attempt path ran.

4. **WakeSocketServer does NOT clobber live peers.**
   - Test: `tests/unit/wake-socket-server-stale-recovery.test.ts > refuses to clobber a live peer (surfaces EADDRINUSE)`
   - Binds a real `net.Server` to the socket path, then attempts to start a second `WakeSocketServer`. Asserts the second emits EADDRINUSE without taking the path away from the live peer.

5. **WakeSocketServer recovers from stale socket.**
   - Test: `tests/unit/wake-socket-server-stale-recovery.test.ts > cleans up a stale socket file on start (pre-bind unlink path)` and `> recovers from EADDRINUSE when no live peer is listening`
   - Plants an empty file at the socket path, starts the server, asserts the listen succeeds.

## Notes for second-pass reviewer

- **Why always `.cjs` and not "always write both `.js` and `.cjs`?":**
  Considered. Always-both would allow rollback to point at `.js` if
  needed. Rejected because: (1) `.js` in a `type=module` project is a
  broken artifact (Node can't load it as CJS); (2) the migrator
  regenerates plists to `.cjs` automatically, so rollback isn't a
  user-visible scenario; (3) keeping an unused broken file invites
  confusion. The current code leaves `.js` files alone but doesn't
  create new ones.

- **Why not run the migrator on every lifeline boot instead of relying
  on `PostUpdateMigrator`?** `selfHealPlist` already does the
  equivalent on every lifeline boot — it's Check 4 of that function.
  The migrator entry catches the case where the agent installs the new
  instar version but hasn't yet booted the lifeline (e.g., the
  postupdate migration runs first).

- **Why probe-then-unlink instead of just `listen()`-then-error-bubble
  on EADDRINUSE?** Without the recovery path, a stale socket file from
  an unclean exit blocks startup forever until the operator manually
  removes it. The probe-then-unlink preserves correctness (don't
  clobber live peers) while restoring the auto-recovery the original
  pre-bind-unlink path provided.

- **Migrator side-effect on darwin only:** Linux systemd unit files
  reference the bash wrapper (`instar-boot.sh`) which is unaffected
  by this change. Non-darwin migrator path is a no-op skip.

## Rollback playbook

If this PR causes regressions:

1. `git revert <pr-merge-sha>` on the canonical instar repo's `main`.
2. Tag a patch release (e.g., `v1.1.2`) with the revert.
3. `npx instar` auto-update propagates the revert to all in-the-wild
   agents on next supervision cycle.
4. Agents whose plists were already migrated to `.cjs` continue to
   work — `installBootWrapper` post-revert writes `.cjs` for projects
   with `type=module`, which matches what the migrated plists reference.
5. Agents whose plists were NOT yet migrated (still on `.js`)
   continue on `.js` — unchanged from pre-PR state.

No persistent state cleanup required.
